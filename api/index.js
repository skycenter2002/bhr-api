// ============================================================
// BHR Backend API — Vercel Entry Point
// Express app serving all routes
// ============================================================
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ── Firebase Admin Init ──────────────────────────────────────
// Dùng GOOGLE_APPLICATION_CREDENTIALS env var hoặc service account JSON
let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  try {
    // Vercel: dùng env var FIREBASE_SERVICE_ACCOUNT (JSON string)
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;

    if (serviceAccount) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
      });
    } else {
      // Fallback: Application Default Credentials
      admin.initializeApp({
        databaseURL: process.env.FIREBASE_DB_URL
      });
    }
    firebaseInitialized = true;
  } catch (err) {
    if (err.code === 'app/duplicate-app') {
      firebaseInitialized = true;
    } else {
      console.error('Firebase init error:', err.message);
    }
  }
}

initFirebase();
const db = admin.database();

// ── Express App ───────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Import routes
const strava = require('./strava');
const stats = require('./stats');
const bm = require('./bestmarathon');

// ── Routes ────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/stats', stats.getStats);
app.get('/vo2maxlogs', stats.getVO2MaxLogs);
app.get('/runners', stats.getRunners);

app.post('/bmsync', bm.fetchBMSync);
app.post('/bmsync/assign', bm.assignBMId);

app.post('/sync', strava.syncRunner);
app.post('/sync/all', strava.syncAll);

app.post('/register', async (req, res) => {
  const { name, club } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Vui lòng điền Họ và tên!' });

  const tempId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try {
    await db.ref(`pending/${tempId}`).set({
      name: name.trim(),
      club: (club || '').trim(),
      timestamp: new Date().toISOString()
    });
    const stravaAuthUrl = strava.buildStravaAuthUrl(tempId);
    res.json({ success: true, stravaAuthUrl });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Strava OAuth callback — redirect
app.get('/stravaCallback', strava.handleCallback);

// ── Export for Vercel ─────────────────────────────────────────
module.exports = app;

// ── Local dev server ──────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`BHR API running on http://localhost:${PORT}`));
}
