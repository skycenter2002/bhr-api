// ============================================================
// bestmarathon.js — BestMarathon.vn scraping & PR sync
// Port từ Helpers.gs fetchBMSync_proxy() & assignBMId_proxy()
// ============================================================
const admin = require('firebase-admin');
const axios = require('axios');

const db = admin.database();

function removeAccents(str) {
  return str.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function paceToMins(paceStr) {
  if (!paceStr) return 0;
  const p = paceStr.replace('/km', '').trim().split(':');
  if (p.length === 2) return parseInt(p[0]) + parseInt(p[1]) / 60;
  return 0;
}

// ── POST /api/bmsync — Scrape BestMarathon & match runners ──
async function fetchBMSync(req, res) {
  try {
    // 1. Tải nonce từ BestMarathon
    const htmlResp = await axios.get('https://bestmarathon.vn/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    const html = htmlResp.data;
    const nonceMatch = html.match(/nonce:\s*'([^']+)'/);
    if (!nonceMatch) {
      return res.status(500).json({ success: false, message: 'Không tìm thấy Nonce BestMarathon' });
    }
    const nonce = nonceMatch[1];

    // 2. Hàm lấy data từ sheet BM
    async function fetchSheet(sheetId) {
      const resp = await axios.post(
        'https://bestmarathon.vn/wp-admin/admin-ajax.php',
        new URLSearchParams({ action: 'jp_google_sheet_api_get_data', sheet: sheetId, nonce }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }
      );
      const json = resp.data;
      if (json && json.success && json.data) return json.data;
      return [];
    }

    const [fmM, fmF, hmM, hmF] = await Promise.all([
      fetchSheet('FM-M'), fetchSheet('FM-F'),
      fetchSheet('HM-M'), fetchSheet('HM-F')
    ]);

    // 3. Build BestMarathon records map
    const bmRecordsMap = {};
    function mapRecords(sheetData, isHM) {
      for (let k = 1; k < sheetData.length; k++) {
        const row = sheetData[k];
        if (!row || row.length < 14) continue;
        const displayBM = String(row[9] || row[13] || row[1] || '').trim();
        const prTime = row[2] || '';
        const paceStr = String(row[7] || '').replace('/km', '').trim();
        const clubRaw = String(row[10] || '');
        const clubClean = clubRaw.replace(/<[^>]+>/g, '').trim();
        const bmIdCandidate = `${displayBM}|${clubClean}`;

        if (!bmRecordsMap[bmIdCandidate]) {
          bmRecordsMap[bmIdCandidate] = {
            bmId: bmIdCandidate, displayBM, clubClean,
            prFM: '', paceFM: '', prHM: '', paceHM: ''
          };
        }
        if (isHM) {
          if (!bmRecordsMap[bmIdCandidate].prHM) {
            bmRecordsMap[bmIdCandidate].prHM = prTime;
            bmRecordsMap[bmIdCandidate].paceHM = paceStr;
          }
        } else {
          if (!bmRecordsMap[bmIdCandidate].prFM) {
            bmRecordsMap[bmIdCandidate].prFM = prTime;
            bmRecordsMap[bmIdCandidate].paceFM = paceStr;
          }
        }
      }
    }
    mapRecords(fmM, false); mapRecords(fmF, false);
    mapRecords(hmM, true); mapRecords(hmF, true);

    // 4. Lấy runners từ DB và match
    const runnersSnap = await db.ref('runners').once('value');
    if (!runnersSnap.exists()) {
      return res.json({ success: true, updated: 0, ambiguous: {} });
    }

    const runners = runnersSnap.val();
    const ambiguous = {};
    const updates = {};
    let updateCount = 0;

    for (const [sid, runner] of Object.entries(runners)) {
      const rName = (runner.name || '').trim();
      const rClub = (runner.club || '').trim().toLowerCase();
      const bmIdExisting = runner.bmId || '';
      if (!rName) continue;

      const rKey = rName.toLowerCase();
      const asciiSearch = removeAccents(rKey);
      let exactMatchRecord = null;
      const candidatesList = [];

      for (const [cId, rec] of Object.entries(bmRecordsMap)) {
        const asciiBM = removeAccents(rec.displayBM.toLowerCase());
        const utf8BM = rec.displayBM.toLowerCase();

        if (bmIdExisting && bmIdExisting === cId) {
          exactMatchRecord = rec;
          break;
        }
        if (!bmIdExisting && (utf8BM.includes(rKey) || asciiBM.includes(asciiSearch))) {
          candidatesList.push(rec);
        }
      }

      if (exactMatchRecord) {
        updates[`runners/${sid}/bmPr`] = exactMatchRecord.prFM;
        updates[`runners/${sid}/bmPace`] = exactMatchRecord.paceFM;
        updates[`runners/${sid}/bmHmPr`] = exactMatchRecord.prHM;
        updates[`runners/${sid}/bmHmPace`] = exactMatchRecord.paceHM;
        updateCount++;
      } else if (!bmIdExisting && candidatesList.length > 0) {
        const clubFiltered = candidatesList.filter(c =>
          c.clubClean.toLowerCase().includes(rClub) || rClub.includes(c.clubClean.toLowerCase())
        );
        const finals = clubFiltered.length === 1 ? clubFiltered : candidatesList;

        if (finals.length === 1) {
          updates[`runners/${sid}/bmId`] = finals[0].bmId;
          updates[`runners/${sid}/bmPr`] = finals[0].prFM;
          updates[`runners/${sid}/bmPace`] = finals[0].paceFM;
          updates[`runners/${sid}/bmHmPr`] = finals[0].prHM;
          updates[`runners/${sid}/bmHmPace`] = finals[0].paceHM;
          updateCount++;
        } else {
          ambiguous[sid] = { name: rName, candidates: finals.slice(0, 15) };
        }
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.ref().update(updates);
    }

    res.json({ success: true, updated: updateCount, ambiguous });
  } catch (err) {
    console.error('[fetchBMSync]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── POST /api/bmsync/assign — Gán bmId thủ công ─────────────
async function assignBMId(req, res) {
  const { stravaId, rec } = req.body;
  if (!stravaId || !rec) {
    return res.status(400).json({ success: false, message: 'Missing stravaId or rec' });
  }
  try {
    await db.ref(`runners/${stravaId}`).update({
      bmId: rec.bmId,
      bmPr: rec.prFM || '',
      bmPace: rec.paceFM || '',
      bmHmPr: rec.prHM || '',
      bmHmPace: rec.paceHM || ''
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { fetchBMSync, assignBMId };
