// ============================================================
// stats.js — Leaderboard, VO2Max computation
// Port từ Code.gs getStatsData() & getVO2MaxLogs_proxy()
// ============================================================
const admin = require('firebase-admin');
const db = admin.database();

// ── Helpers ──────────────────────────────────────────────────
function formatPaceMMSS(dec) {
  if (!dec || dec <= 0) return '-';
  const m = Math.floor(dec);
  let s = Math.round((dec - m) * 60);
  if (s === 60) { return `${m + 1}.00`; }
  return `${m}.${s < 10 ? '0' + s : s}`;
}

function formatTime(mins) {
  if (!mins || mins >= 999999) return '-';
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  const s = Math.round((mins - Math.floor(mins / 60) * 60 - m) * 60);
  return `${h}:${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`;
}

function paceStrToMins(paceStr) {
  if (!paceStr || typeof paceStr !== 'string') return 0;
  const parts = paceStr.replace('/km', '').trim().split(':');
  if (parts.length === 2) return parseInt(parts[0]) + parseInt(parts[1]) / 60;
  return 0;
}

function timeStrToMins(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 999999;
  const p = timeStr.split(':');
  if (p.length === 3) return parseInt(p[0]) * 60 + parseInt(p[1]) + parseInt(p[2]) / 60;
  if (p.length === 2) return parseInt(p[0]) + parseInt(p[1]) / 60;
  return 999999;
}

// ── VO2Max Calculation Engine ────────────────────────────────
function computeVO2Max(acts, splits, prFMMins, prHMMins, age) {
  if (!acts || acts.length === 0) return { finalVO2: 0, vdotPR: 0, avg90: 0 };

  // Tính VDOT từ PR race
  let vdotPR = 0;
  if (prFMMins && prFMMins < 999999) {
    const v = 42195 / prFMMins;
    const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
    const frac = 0.8 + 0.1894393 * Math.exp(-0.012778 * prFMMins) + 0.2989558 * Math.exp(-0.1932605 * prFMMins);
    if (frac > 0) vdotPR = Math.max(vdotPR, vo2 / frac);
  }
  if (prHMMins && prHMMins < 999999) {
    const v = 21097.5 / prHMMins;
    const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
    const frac = 0.8 + 0.1894393 * Math.exp(-0.012778 * prHMMins) + 0.2989558 * Math.exp(-0.1932605 * prHMMins);
    if (frac > 0) vdotPR = Math.max(vdotPR, vo2 / frac);
  }

  // HR data collection for quantile
  const hrArray = [];
  acts.forEach(a => {
    const asp = splits[a.actId];
    if (asp) asp.forEach(sp => { if (sp.hr > 0 && sp.hr <= 205) hrArray.push(sp.hr); });
    else if (a.avgHr > 0 && a.avgHr <= 205) hrArray.push(a.avgHr);
  });

  let hr_max = 185;
  let hr_rest = 60;

  if (hrArray.length > 0) {
    hrArray.sort((a, b) => a - b);
    const p95 = Math.min(Math.floor(hrArray.length * 0.95), hrArray.length - 1);
    const highHrs = hrArray.filter(h => h >= hrArray[p95]);
    if (highHrs.length > 0) hr_max = Math.min(Math.max(...highHrs) + 3, 205);
    hr_rest = vdotPR > 0 ? Math.max(40, 85 - vdotPR * 0.5) : 65;
  }

  // Compute per-session VO2Max
  const validSessions = [];
  acts.sort((a, b) => new Date(a.date) - new Date(b.date));

  acts.forEach(a => {
    if (a.mins <= 0 || a.km <= 0) return;
    const asp = splits[a.actId];
    const splitVo2s = [];
    if (asp) {
      asp.forEach(sp => {
        const hrr = (sp.hr - hr_rest) / (hr_max - hr_rest);
        if (sp.distance >= 500 && hrr >= 0.60) {
          const v_m_min = sp.distance / (sp.movingTime / 60.0);
          const vo2_curr = 0.2 * v_m_min + 3.5;
          const vo2_max = (vo2_curr - 3.5) / hrr + 3.5;
          if (vo2_max >= 20 && vo2_max <= 85) splitVo2s.push(vo2_max);
        }
      });
    }
    if (splitVo2s.length > 0) {
      validSessions.push(splitVo2s.reduce((s, v) => s + v, 0) / splitVo2s.length);
    }
  });

  let avg90 = 0;
  let recentTrend = 0;
  if (validSessions.length > 0) {
    avg90 = validSessions.reduce((s, v) => s + v, 0) / validSessions.length;
    recentTrend = validSessions[0];
    for (let i = 1; i < validSessions.length; i++) {
      recentTrend = recentTrend * 0.70 + validSessions[i] * 0.30;
    }
  }

  const finalVO2 = recentTrend > 0 ? recentTrend : (vdotPR > 0 ? vdotPR : 40.0);
  return { finalVO2, vdotPR, avg90 };
}

// ── GET /api/stats — Leaderboard data ────────────────────────
async function getStats(req, res) {
  try {
    const period = req.query.period || 'week'; // 'week','month','year','all'

    const [runnersSnap, activitiesSnap, splitsSnap] = await Promise.all([
      db.ref('runners').once('value'),
      db.ref('activities').once('value'),
      db.ref('splits').once('value')
    ]);

    if (!runnersSnap.exists()) {
      return res.json({ success: true, runners: [], period });
    }

    const runnersData = runnersSnap.val() || {};
    const allActivities = activitiesSnap.exists() ? activitiesSnap.val() : {};
    const allSplits = splitsSnap.exists() ? splitsSnap.val() : {};

    const now = new Date();
    // Xác định khoảng thời gian
    function getPeriodStart(p) {
      const d = new Date(now);
      if (p === 'week') {
        const day = d.getDay();
        d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
        d.setHours(0, 0, 0, 0);
      } else if (p === 'month') {
        d.setDate(1); d.setHours(0, 0, 0, 0);
      } else if (p === 'year') {
        d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
      } else {
        return new Date(2000, 0, 1);
      }
      return d;
    }
    const periodStart = getPeriodStart(period);
    const ms90 = 90 * 24 * 3600 * 1000;

    const boardMap = {};

    // Khởi tạo tất cả runners
    for (const [sid, runner] of Object.entries(runnersData)) {
      boardMap[sid] = {
        stravaId: sid,
        name: runner.name || 'Vô Danh',
        club: runner.club || '',
        avatar: runner.avatar || '',
        totalKm: 0,
        totalMins: 0,
        totalRuns: 0,
        prFMMins: 999999, prFMPace: '-', prFMFormatted: '-',
        prHMMins: 999999, prHMPace: '-', prHMFormatted: '-',
        pr10KMins: 999999, pr10KPace: '-',
        pr5KMins: 999999, pr5KPace: '-',
        avgPace: 0, avgPaceFormatted: '-',
        vdot90: 0, vdotPR: 0, avg90: 0,
        vdot90Formatted: '-',
        bmId: runner.bmId || '',
        bmPrFM: runner.bmPr || '',
        bmPrHM: runner.bmHmPr || ''
      };

      // Load BM PR
      if (runner.bmPr) {
        const m = timeStrToMins(runner.bmPr);
        if (m < 999999) {
          boardMap[sid].prFMMins = m;
          boardMap[sid].prFMPace = runner.bmPace || '-';
          boardMap[sid].prFMFormatted = runner.bmPr;
        }
      }
      if (runner.bmHmPr) {
        const m = timeStrToMins(runner.bmHmPr);
        if (m < 999999) {
          boardMap[sid].prHMMins = m;
          boardMap[sid].prHMPace = runner.bmHmPace || '-';
          boardMap[sid].prHMFormatted = runner.bmHmPr;
        }
      }
    }

    const recentActs = {}; // actId→splits for VO2Max (last 90 days)

    // Process activities
    for (const [sid, actsObj] of Object.entries(allActivities)) {
      const board = boardMap[sid];
      if (!board) continue;

      const acts = Object.values(actsObj);
      const periodActs = [];
      const last90Acts = [];

      acts.forEach(a => {
        if (!a.date) return;
        const d = new Date(a.date);
        if (now - d <= ms90) {
          last90Acts.push(a);
        }
        if (d >= periodStart) {
          periodActs.push(a);
        }
      });

      // Tổng kết period
      periodActs.forEach(a => {
        board.totalKm += a.km || 0;
        board.totalMins += a.mins || 0;
        board.totalRuns++;
      });

      // PR tracking (toàn thời gian)
      acts.forEach(a => {
        const km = a.km || 0;
        const mins = a.mins || 0;
        if (km <= 0 || mins <= 0) return;
        const pace = mins / km;

        if (km >= 40) {
          if (mins < board.prFMMins) {
            board.prFMMins = mins;
            board.prFMPace = pace;
            board.prFMFormatted = formatTime(mins);
          }
        } else if (km >= 19) {
          if (mins < board.prHMMins) {
            board.prHMMins = mins;
            board.prHMPace = pace;
            board.prHMFormatted = formatTime(mins);
          }
        } else if (km >= 9) {
          const extrapolated10K = mins * (10 / km);
          if (extrapolated10K < board.pr10KMins) {
            board.pr10KMins = extrapolated10K;
            board.pr10KPace = pace;
          }
        } else if (km >= 4.5) {
          const extrapolated5K = mins * (5 / km);
          if (extrapolated5K < board.pr5KMins) {
            board.pr5KMins = extrapolated5K;
            board.pr5KPace = pace;
          }
        }
      });

      // VO2Max dùng last 90 days
      if (!recentActs[sid]) recentActs[sid] = last90Acts;
    }

    // Compute VO2Max for each runner
    for (const [sid, board] of Object.entries(boardMap)) {
      const acts = recentActs[sid] || [];
      const splitsMap = {};
      acts.forEach(a => {
        if (allSplits[a.actId]) splitsMap[a.actId] = allSplits[a.actId];
      });

      const { finalVO2, vdotPR, avg90 } = computeVO2Max(
        acts, splitsMap,
        board.prFMMins, board.prHMMins,
        0 // age — không lưu tuổi trong DB hiện tại
      );
      board.vdot90 = finalVO2;
      board.vdotPR = vdotPR;
      board.avg90 = avg90;
      board.vdot90Formatted = finalVO2 > 0 ? finalVO2.toFixed(1) : '-';

      // Pace trung bình
      if (board.totalKm > 0) {
        const paceDec = board.totalMins / board.totalKm;
        board.avgPace = paceDec.toFixed(2);
        board.avgPaceFormatted = formatPaceMMSS(paceDec);
      }
      board.totalKm = parseFloat(board.totalKm.toFixed(2));
    }

    // Sắp xếp theo km
    const runners = Object.values(boardMap)
      .filter(r => r.totalKm > 0 || r.vdot90 > 0)
      .sort((a, b) => b.totalKm - a.totalKm)
      .map((r, i) => ({ ...r, rank: i + 1 }));

    res.json({ success: true, period, runners, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[getStats]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/runners — Danh sách runners ────────────────────
async function getRunners(req, res) {
  try {
    const snap = await db.ref('runners').once('value');
    if (!snap.exists()) return res.json({ success: true, runners: [] });
    const runners = Object.entries(snap.val()).map(([sid, r]) => ({
      stravaId: sid,
      name: r.name,
      club: r.club,
      avatar: r.avatar,
      connectedAt: r.connectedAt
    }));
    res.json({ success: true, runners });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── GET /api/vo2maxlogs?runner=X — VO2Max log modal ─────────
async function getVO2MaxLogs(req, res) {
  const runnerName = (req.query.runner || '').trim().toLowerCase();
  if (!runnerName) return res.status(400).json({ success: false, message: 'Missing runner name' });

  try {
    const runnersSnap = await db.ref('runners').once('value');
    if (!runnersSnap.exists()) {
      return res.status(404).json({ success: false, message: 'No runners found' });
    }

    // Tìm runner theo tên
    let foundSid = null;
    let foundRunner = null;
    runnersSnap.forEach(snap => {
      const r = snap.val();
      if ((r.name || '').toLowerCase() === runnerName) {
        foundSid = snap.key;
        foundRunner = r;
      }
    });

    if (!foundSid) {
      return res.status(404).json({ success: false, message: 'Runner not found' });
    }

    const prFMMins = foundRunner.bmPr ? timeStrToMins(foundRunner.bmPr) : 999999;
    const prHMMins = foundRunner.bmHmPr ? timeStrToMins(foundRunner.bmHmPr) : 999999;

    // Lấy activities last 90 days
    const actsSnap = await db.ref(`activities/${foundSid}`).once('value');
    const now = new Date();
    const ms90 = 90 * 24 * 3600 * 1000;

    let myActs = [];
    if (actsSnap.exists()) {
      Object.values(actsSnap.val()).forEach(a => {
        if (!a.date) return;
        const d = new Date(a.date);
        if (now - d <= ms90) myActs.push(a);
      });
    }
    myActs.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Lấy splits
    const splitsMap = {};
    for (const a of myActs) {
      const sp = await db.ref(`splits/${a.actId}`).once('value');
      if (sp.exists()) splitsMap[a.actId] = sp.val();
    }

    // Tính HR params
    const hrArray = [];
    myActs.forEach(a => {
      const asp = splitsMap[a.actId];
      if (asp) Object.values(asp).forEach(sp => { if (sp.hr > 0 && sp.hr <= 205) hrArray.push(sp.hr); });
      else if (a.avgHr > 0 && a.avgHr <= 205) hrArray.push(a.avgHr);
    });

    let hr_max = 185, hr_rest = 60;
    let vdotPR = 0;
    if (prFMMins < 999999) {
      const v = 42195 / prFMMins;
      const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
      const frac = 0.8 + 0.1894393 * Math.exp(-0.012778 * prFMMins) + 0.2989558 * Math.exp(-0.1932605 * prFMMins);
      if (frac > 0) vdotPR = Math.max(vdotPR, vo2 / frac);
    }

    if (hrArray.length > 0) {
      hrArray.sort((a, b) => a - b);
      const p95 = Math.min(Math.floor(hrArray.length * 0.95), hrArray.length - 1);
      const highHrs = hrArray.filter(h => h >= hrArray[p95]);
      if (highHrs.length > 0) hr_max = Math.min(Math.max(...highHrs) + 3, 205);
      hr_rest = vdotPR > 0 ? Math.max(40, 85 - vdotPR * 0.5) : 65;
    }

    // Build logs
    const pad = n => (n < 10 ? '0' : '') + n;
    const validSessions = [];
    const sessionRecords = [];

    myActs.forEach(a => {
      if (a.mins <= 0 || a.km <= 0) { sessionRecords.push(0); return; }
      const asp = splitsMap[a.actId];
      const splitVo2s = [];
      if (asp) {
        const sArr = Array.isArray(asp) ? asp : Object.values(asp);
        sArr.forEach(sp => {
          if (sp.distance >= 500 && sp.hr >= Math.max(135, hr_max * 0.75)) {
            const v_m_min = sp.distance / (sp.movingTime / 60.0);
            const vo2_curr = 0.2 * v_m_min + 3.5;
            const hrr = (sp.hr - hr_rest) / (hr_max - hr_rest);
            if (hrr > 0) {
              let vo2_max = (vo2_curr - 3.5) / hrr + 3.5;
              if (vdotPR > 0) vo2_max = Math.min(vo2_max, vdotPR * 1.30);
              if (vo2_max >= 20 && vo2_max <= 85) splitVo2s.push(vo2_max);
            }
          }
        });
      }
      if (splitVo2s.length > 0) {
        const sv = splitVo2s.reduce((s, v) => s + v, 0) / splitVo2s.length;
        validSessions.push(sv);
        sessionRecords.push(sv);
      } else {
        sessionRecords.push(0);
      }
    });

    let avg90 = 0, recent_trend = 0;
    if (validSessions.length > 0) {
      avg90 = validSessions.reduce((s, v) => s + v, 0) / validSessions.length;
      recent_trend = validSessions[0];
      for (let i = 1; i < validSessions.length; i++) {
        recent_trend = recent_trend * 0.70 + validSessions[i] * 0.30;
      }
    }

    let running_ema = null;
    const logs = [];

    myActs.forEach((a, idx) => {
      if (a.mins <= 0 || a.km <= 0) return;
      const sv = sessionRecords[idx];
      if (sv > 0) {
        running_ema = running_ema === null ? sv : running_ema * 0.70 + sv * 0.30;
      }

      const d = new Date(a.date);
      const dStr = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const raw_avg = a.mins / a.km;
      const apm = Math.floor(raw_avg);
      let aps = Math.round((raw_avg - apm) * 60);
      if (aps === 60) { aps = 0; }
      logs.push({
        date: dStr,
        distance: (a.km || 0).toFixed(1),
        target_pace: `${Math.round(a.avgHr || 0)} bpm`,
        best_split: '-',
        avg_pace: `${apm}:${pad(aps)}`,
        delta: sv > 0 ? sv.toFixed(1) : '-',
        vdot_new: running_ema !== null ? running_ema.toFixed(1) : '-'
      });
    });

    const diff = recent_trend - avg90;
    const trend_str = diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);

    res.json({
      success: true,
      data: {
        runner: foundRunner.name,
        club: foundRunner.club || '',
        avatar: foundRunner.avatar || '',
        vdot_start: avg90 > 0 ? avg90.toFixed(1) : '-',
        vdot_current: recent_trend > 0 ? recent_trend.toFixed(1) : '-',
        trend: trend_str,
        logs
      }
    });
  } catch (err) {
    console.error('[getVO2MaxLogs]', err);
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getStats, getRunners, getVO2MaxLogs };
