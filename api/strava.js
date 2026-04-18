// ============================================================
// strava.js — Strava OAuth & Activity Sync
// Port từ Code.gs → Firebase Cloud Functions
// ============================================================
const admin = require('firebase-admin');
const axios = require('axios');
const functions = require('firebase-functions');

const db = admin.database();

const STRAVA_CLIENT_ID = '165837';
const STRAVA_CLIENT_SECRET = '025aa7b5e144098b6032eb21d7b2e065bc39dd46';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://bienhoa.web.app';
// Strava OAuth callback URL — Vercel deployment
// Update after: npx vercel --prod (lấy URL mới rồi cập nhật ở đây và trên Strava API settings)
const CALLBACK_URL = process.env.STRAVA_CALLBACK_URL || 'https://bhr-api.vercel.app/stravaCallback';

// ── Helper: Làm mới access token Strava ──────────────────────
async function getValidToken(runner) {
  const now = Math.floor(Date.now() / 1000);
  if (runner.tokenExpires && now < runner.tokenExpires - 60) {
    return runner.accessToken;
  }
  // Token hết hạn → refresh
  try {
    const resp = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: runner.refreshToken
    });
    const data = resp.data;
    // Cập nhật token mới vào DB
    const ref = db.ref(`runners/${runner.stravaId}`);
    await ref.update({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || runner.refreshToken,
      tokenExpires: data.expires_at
    });
    return data.access_token;
  } catch (err) {
    console.error('[getValidToken] Error:', err.message);
    throw err;
  }
}

// ── OAuth Callback (GET từ Strava redirect) ──────────────────
async function handleCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${WEBAPP_URL}/register.html?error=strava_denied`);
  }
  if (!code) {
    return res.redirect(`${WEBAPP_URL}/register.html?error=no_code`);
  }

  try {
    // Đổi code lấy token
    const tokenResp = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    });
    const tokenData = tokenResp.data;
    const athlete = tokenData.athlete;

    if (!athlete) {
      return res.redirect(`${WEBAPP_URL}/register.html?error=no_athlete`);
    }

    const stravaId = String(athlete.id);

    // Lấy pending registration data từ state (tempId)
    let pendingData = { name: '', club: '' };
    if (state) {
      const pendingRef = db.ref(`pending/${state}`);
      const snap = await pendingRef.once('value');
      if (snap.exists()) {
        pendingData = snap.val();
        await pendingRef.remove();
      }
    }

    // Lưu runner vào Firebase DB
    const runnerData = {
      stravaId,
      name: pendingData.name || `${athlete.firstname} ${athlete.lastname}`,
      club: pendingData.club || '',
      avatar: athlete.profile_medium || athlete.profile || '',
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenExpires: tokenData.expires_at,
      connectedAt: new Date().toISOString(),
      stravaProfile: {
        firstname: athlete.firstname,
        lastname: athlete.lastname,
        city: athlete.city || '',
        country: athlete.country || '',
        sex: athlete.sex || ''
      }
    };

    const runnerRef = db.ref(`runners/${stravaId}`);
    const existing = await runnerRef.once('value');
    if (existing.exists()) {
      // Chỉ update token, giữ data cũ
      await runnerRef.update({
        accessToken: runnerData.accessToken,
        refreshToken: runnerData.refreshToken,
        tokenExpires: runnerData.tokenExpires,
        avatar: runnerData.avatar
      });
    } else {
      await runnerRef.set(runnerData);
    }

    // Bắt đầu sync activities ngay
    try {
      await syncActivities(stravaId, runnerData.accessToken, true);
    } catch (syncErr) {
      console.warn('[handleCallback] Sync error (non-fatal):', syncErr.message);
    }

    return res.redirect(`${WEBAPP_URL}?registered=1&name=${encodeURIComponent(runnerData.name)}`);
  } catch (err) {
    console.error('[handleCallback] Error:', err.message);
    return res.redirect(`${WEBAPP_URL}/register.html?error=server_error`);
  }
}

// ── Sync activities cho 1 runner ────────────────────────────
async function syncActivities(stravaId, accessToken, isNew = false) {
  const perPage = 100;
  // Lấy epoch timestamp của activity mới nhất đã có trong DB
  let afterTs = 0;
  if (!isNew) {
    const lastRef = db.ref(`runners/${stravaId}/lastSyncAt`);
    const lastSnap = await lastRef.once('value');
    if (lastSnap.exists()) {
      afterTs = Math.floor(new Date(lastSnap.val()).getTime() / 1000) - 3600; // trừ 1h để tránh miss
    }
  } else {
    // Lần đầu: lấy 1 năm gần nhất
    afterTs = Math.floor((Date.now() - 365 * 24 * 3600 * 1000) / 1000);
  }

  let page = 1;
  let totalSynced = 0;

  while (true) {
    const url = `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}&page=${page}&after=${afterTs}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const activities = resp.data;
    if (!activities || activities.length === 0) break;

    const actBatch = {};
    const splitsBatch = {};

    for (const act of activities) {
      if (act.type !== 'Run' && act.sport_type !== 'Run') continue;

      const actId = String(act.id);
      const km = parseFloat((act.distance / 1000).toFixed(3));
      const mins = parseFloat((act.moving_time / 60).toFixed(3));
      const pace = km > 0 ? parseFloat((mins / km).toFixed(4)) : 0;

      actBatch[actId] = {
        actId,
        name: act.name || '',
        date: act.start_date_local || act.start_date,
        km,
        mins,
        pace,
        elevation: act.total_elevation_gain || 0,
        calories: act.calories || 0,
        avgHr: act.average_heartrate || 0,
        maxHr: act.max_heartrate || 0,
        avgSpeed: parseFloat((act.average_speed || 0).toFixed(4)),
        type: 'Run'
      };
      totalSynced++;

      // Sync splits ngay sau mỗi activity
      try {
        const splitResp = await axios.get(
          `https://www.strava.com/api/v3/activities/${actId}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const detail = splitResp.data;
        if (detail.splits_metric && detail.splits_metric.length > 0) {
          splitsBatch[actId] = detail.splits_metric.map((sp, i) => ({
            km: i + 1,
            split: i + 1,
            movingTime: sp.moving_time || 0,
            distance: sp.distance || 0,
            speed: parseFloat((sp.average_speed || 0).toFixed(4)),
            hr: sp.average_heartrate || 0,
            elevation: sp.elevation_difference || 0
          }));
        }
      } catch (splitErr) {
        // Non-fatal
      }
    }

    // Ghi activities vào DB
    if (Object.keys(actBatch).length > 0) {
      await db.ref(`activities/${stravaId}`).update(actBatch);
    }
    // Ghi splits vào DB
    for (const [aId, splits] of Object.entries(splitsBatch)) {
      await db.ref(`splits/${aId}`).set(splits);
    }

    if (activities.length < perPage) break;
    page++;
  }

  // Cập nhật thời gian sync
  await db.ref(`runners/${stravaId}`).update({
    lastSyncAt: new Date().toISOString()
  });

  console.log(`[syncActivities] stravaId=${stravaId} synced ${totalSynced} activities`);
  return totalSynced;
}

// ── HTTP: Sync 1 runner (POST /api/sync) ────────────────────
async function syncRunner(req, res) {
  const { stravaId } = req.body;
  if (!stravaId) return res.status(400).json({ success: false, message: 'Missing stravaId' });

  try {
    const snap = await db.ref(`runners/${stravaId}`).once('value');
    if (!snap.exists()) {
      return res.status(404).json({ success: false, message: 'Runner not found' });
    }
    const runner = snap.val();
    runner.stravaId = stravaId;

    const token = await getValidToken(runner);
    const count = await syncActivities(stravaId, token);
    res.json({ success: true, synced: count });
  } catch (err) {
    console.error('[syncRunner]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── Sync tất cả runners ──────────────────────────────────────
async function syncAllRunners() {
  const snap = await db.ref('runners').once('value');
  if (!snap.exists()) return;

  const runners = snap.val();
  const ids = Object.keys(runners);
  console.log(`[syncAllRunners] Syncing ${ids.length} runners...`);

  for (const stravaId of ids) {
    const runner = runners[stravaId];
    runner.stravaId = stravaId;
    try {
      const token = await getValidToken(runner);
      await syncActivities(stravaId, token);
    } catch (err) {
      console.error(`[syncAllRunners] Error for ${stravaId}:`, err.message);
    }
  }
  console.log('[syncAllRunners] Done.');
}

// ── HTTP: Sync all (POST /api/sync/all) ─────────────────────
async function syncAll(req, res) {
  try {
    await syncAllRunners();
    res.json({ success: true, message: 'All runners synced' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── Build Strava Auth URL ────────────────────────────────────
function buildStravaAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state: state || ''
  });
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

module.exports = {
  handleCallback,
  syncRunner,
  syncAll,
  syncAllRunners,
  getValidToken,
  buildStravaAuthUrl,
  CALLBACK_URL
};
