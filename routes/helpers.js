/**
 * Housely — shared route helpers
 * Period/balance resolution, money validation, activity logging, permission matrix.
 */

const crypto = require('crypto');
const {
  Family,
  User,
  TrackingPeriod,
  GroceryBalance,
  PersonalBalance,
  ActivityLog,
} = require('../models');

// ---------------------------------------------------------------------------
// Money — every money value in the API is an integer number of sen (RM × 100)
// ---------------------------------------------------------------------------
const MAX_SEN = 1_000_000_000_000_00; // RM 1,000,000,000,000 cap sanity

function isValidMoney(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_SEN;
}

/** Convert a user-typed RM string/number into an integer sen value, or null. */
function rmToSen(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ---------------------------------------------------------------------------
// Async handler wrapper (Express 4 doesn't catch rejected promises by default)
// ---------------------------------------------------------------------------
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Family / period / balances
// ---------------------------------------------------------------------------
async function getFamily() {
  return Family.findOne().sort({ createdAt: 1 }).lean();
}

async function getActivePeriod(familyId) {
  return TrackingPeriod.findOne({ familyId, status: 'active' });
}

/** Fetch (creating if missing) the grocery balance for a period. */
async function getGroceryBalance(familyId, periodId) {
  return GroceryBalance.findOneAndUpdate(
    { familyId, periodId },
    { $setOnInsert: { funded: 0, spent: 0, budgetAmount: 0 } },
    { upsert: true, new: true }
  );
}

/** Fetch (creating if missing) a personal balance for a user+period. */
async function getPersonalBalance(userId, periodId) {
  return PersonalBalance.findOneAndUpdate(
    { userId, periodId },
    { $setOnInsert: { funded: 0, spent: 0, fundedBy: [] } },
    { upsert: true, new: true }
  );
}

// ---------------------------------------------------------------------------
// Permission matrix — the dual-balance rules, the heart of the app
// ---------------------------------------------------------------------------
const canFundGroceries = (role) => role === 'provider' || role === 'grocery_spender';
const canSpendGroceries = (role) => ['provider', 'grocery_spender', 'member'].includes(role);
const canFundAnyone = (role) => role === 'provider' || role === 'grocery_spender';
const canManageBalances = (role) => role === 'provider' || role === 'grocery_spender';
const canResetPinFor = (actorRole, targetRole) =>
  actorRole === 'provider' || (actorRole === 'grocery_spender' && targetRole === 'dependent');
const canEditRecord = (actorRole, recordOwnerId, actorId) =>
  actorRole === 'provider' || String(recordOwnerId) === String(actorId);

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
async function logActivity({
  familyId,
  actor,
  type,
  subjectUserId = null,
  message,
  amount = 0,
  meta = {},
}) {
  await ActivityLog.create({
    familyId,
    actorId: actor._id,
    actorName: actor.name,
    type,
    subjectUserId,
    message,
    amount,
    meta,
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
function dayKey(date) {
  // Calendar-day key in Malaysia time (UTC+8) — used for duplicate detection.
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireObjectId(value, what = 'id') {
  const mongoose = require('mongoose');
  if (!mongoose.Types.ObjectId.isValid(String(value))) {
    const err = new Error(`Invalid ${what}.`);
    err.status = 400;
    throw err;
  }
  return String(value);
}

module.exports = {
  ah,
  isValidMoney,
  rmToSen,
  getFamily,
  getActivePeriod,
  getGroceryBalance,
  getPersonalBalance,
  canFundGroceries,
  canSpendGroceries,
  canFundAnyone,
  canManageBalances,
  canResetPinFor,
  canEditRecord,
  logActivity,
  dayKey,
  sha256,
  randomToken,
  requireObjectId,
};
