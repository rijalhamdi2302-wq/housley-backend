/**
 * Housely — Express server entry.
 * Mounts every route under /api, applies security middleware and rate limits.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI is missing. Copy backend/.env.example to backend/.env and fill it in.');
  process.exit(1);
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('✗ JWT_SECRET is missing or too short (min 16 chars). Fix backend/.env.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// --- Security middleware ----------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false, // Capacitor webview + Vite dev need flexibility
  })
);

// Capacitor Android uses androidScheme "https", so the webview origin is https://localhost
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,https://localhost,capacitor://localhost,http://localhost').split(',').map((s) => s.trim());
app.use(
  cors({
    origin(origin, cb) {
      // Allow no-origin requests (native apps, curl, Capacitor) and listed origins
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
  })
);

// Proof images are base64 data URLs — allow a comfortable body size
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// Global API rate limit (generous; per-route limits are tighter where it matters)
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  })
);

// --- Routes ------------------------------------------------------------------
const routes = {
  auth: require('./routes/auth'),
  funding: require('./routes/funding'),
  expenses: require('./routes/expenses'),
  checklist: require('./routes/checklist'),
  catalog: require('./routes/catalog'),
  categories: require('./routes/categories'),
  analytics: require('./routes/analytics'),
  activity: require('./routes/activity'),
  periods: require('./routes/periods'),
  export: require('./routes/export'),
  import: require('./routes/import'),
  transactions: require('./routes/transactions'),
  bills: require('./routes/bills'),
  goals: require('./routes/goals'),
  meals: require('./routes/meals'),
  chores: require('./routes/chores'),
  social: require('./routes/social'),
  family: require('./routes/family'),
};

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'housely-backend' }));
app.use('/api/auth', routes.auth);
app.use('/api/funding', routes.funding);
app.use('/api/expenses', routes.expenses);
app.use('/api/checklist', routes.checklist);
app.use('/api/catalog', routes.catalog);
app.use('/api/categories', routes.categories);
app.use('/api/analytics', routes.analytics);
app.use('/api/activity', routes.activity);
app.use('/api/periods', routes.periods);
app.use('/api/export', routes.export);
app.use('/api/import', routes.import);
app.use('/api/transactions', routes.transactions);
app.use('/api/bills', routes.bills);
app.use('/api/goals', routes.goals);
app.use('/api/meals', routes.meals);
app.use('/api/chores', routes.chores);
app.use('/api/social', routes.social);
app.use('/api/family', routes.family);

// --- Errors -------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('💥', err);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

// --- Boot ----------------------------------------------------------------------
async function main() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✓ Connected to MongoDB');
  } catch (err) {
    console.error('✗ Could not connect to MongoDB. Check your connection string and network:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`✓ Housely backend running on http://localhost:${PORT}`);
  });
}

main();

module.exports = app; // for tests
