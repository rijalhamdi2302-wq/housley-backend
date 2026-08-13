/**
 * Housely — auth routes
 * PIN-based login with lockout, JWT sessions, refresh tokens for biometric unlock.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { User } = require('../models');
const { requireAuth, requireRole, signToken, normalizePin } = require('../middleware/auth');
const { ah, sha256, randomToken, logActivity, canFundAnyone } = require('./helpers');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60, // generous for a family of 5; the DB lockout is the real brute-force guard
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this device. Please try again in a few minutes.' },
});

// Master factory-reset PIN. Change it in backend/.env (FACTORY_RESET_PIN) if you
// want something different from the family default 0259.
const FACTORY_RESET_PIN = String(process.env.FACTORY_RESET_PIN || '0259').trim();

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many factory-reset attempts. Try again later.' },
});

/** GET /api/auth/profiles — list all family profiles (no PIN hashes). */
router.get(
  '/profiles',
  ah(async (req, res) => {
    const users = await User.find({}).select('+pinHash').sort({ sortOrder: 1, name: 1 });
    res.json({ users: users.map((u) => u.toSafeJSON()) });
  })
);

/** POST /api/auth/set-pin — first-time PIN creation (no auth needed yet). */
router.post(
  '/set-pin',
  pinLimiter,
  ah(async (req, res) => {
    const { userId, pin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const normalized = normalizePin(pin);
    if (!normalized) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

    const user = await User.findById(userId).select('+pinHash');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.pinHash) {
      return res.status(409).json({ error: 'This profile already has a PIN.' });
    }

    user.pinHash = await bcrypt.hash(normalized, BCRYPT_ROUNDS);
    user.failedAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    const family = await require('mongoose').model('Family').findById(user.familyId);
    await logActivity({
      familyId: user.familyId,
      actor: user,
      type: 'pin_set',
      subjectUserId: user._id,
      message: `${user.name} set their PIN.`,
    });

    const token = signToken(user);
    const refreshToken = randomToken();
    user.refreshTokenHash = sha256(refreshToken);
    await user.save();
    res.status(201).json({ token, refreshToken, user: user.toSafeJSON() });
  })
);

/** POST /api/auth/verify-pin — login, enforces lockout. */
router.post(
  '/verify-pin',
  pinLimiter,
  ah(async (req, res) => {
    const { userId, pin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const normalized = normalizePin(pin);
    if (!normalized) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

    const user = await User.findById(userId).select('+pinHash +refreshTokenHash');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!user.pinHash) {
      return res.status(409).json({ error: 'This profile has no PIN yet. Create one first.' });
    }

    // Lockout check
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(423).json({
        error: `Too many wrong attempts. Profile locked for ${mins} more minute(s).`,
        locked: true,
        lockedUntil: user.lockedUntil,
      });
    }

    const ok = await bcrypt.compare(normalized, user.pinHash);
    if (!ok) {
      user.failedAttempts += 1;
      if (user.failedAttempts >= MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.failedAttempts = 0;
        await user.save();
        return res.status(423).json({
          error: 'Too many wrong attempts. Profile locked for 15 minutes.',
          locked: true,
          lockedUntil: user.lockedUntil,
        });
      }
      await user.save();
      const left = MAX_ATTEMPTS - user.failedAttempts;
      return res
        .status(401)
        .json({ error: `Wrong PIN. ${left} attempt(s) left.`, attemptsLeft: left });
    }

    // Success — reset counters, rotate refresh token, issue JWT
    user.failedAttempts = 0;
    user.lockedUntil = null;
    const refreshToken = randomToken();
    user.refreshTokenHash = sha256(refreshToken);
    await user.save();

    const token = signToken(user);
    res.json({ token, refreshToken, user: user.toSafeJSON() });
  })
);

/** POST /api/auth/refresh — exchange a refresh token for a fresh JWT (biometric unlock). */
router.post(
  '/refresh',
  pinLimiter,
  ah(async (req, res) => {
    const { userId, refreshToken } = req.body || {};
    if (!userId || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'userId and refreshToken are required.' });
    }
    const user = await User.findById(userId).select('+pinHash +refreshTokenHash');
    if (!user || !user.refreshTokenHash) {
      return res.status(401).json({ error: 'Session not found. Please log in with your PIN.' });
    }
    // Only profiles that explicitly enabled biometric unlock may use this path.
    if (!user.biometricEnabled) {
      return res.status(403).json({ error: 'Biometric unlock is not enabled for this profile.' });
    }
    if (user.refreshTokenHash !== sha256(refreshToken)) {
      return res.status(401).json({ error: 'Session is invalid. Please log in with your PIN.' });
    }
    // Rotate
    const newRefresh = randomToken();
    user.refreshTokenHash = sha256(newRefresh);
    await user.save();
    res.json({ token: signToken(user), refreshToken: newRefresh, user: user.toSafeJSON() });
  })
);

/** POST /api/auth/change-pin — authenticated user changes their own PIN. */
router.post(
  '/change-pin',
  requireAuth,
  ah(async (req, res) => {
    const { currentPin, newPin } = req.body || {};
    const normalizedNew = normalizePin(newPin);
    if (!normalizedNew) {
      return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
    }
    const user = await User.findById(req.user._id).select('+pinHash');
    const ok = user.pinHash ? await bcrypt.compare(String(currentPin || ''), user.pinHash) : false;
    if (!ok) return res.status(401).json({ error: 'Current PIN is incorrect.' });

    user.pinHash = await bcrypt.hash(normalizedNew, BCRYPT_ROUNDS);
    user.failedAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    await logActivity({
      familyId: user.familyId,
      actor: user,
      type: 'pin_set',
      subjectUserId: user._id,
      message: `${user.name} changed their PIN.`,
    });
    res.json({ ok: true });
  })
);

/** POST /api/auth/reset-pin — provider resets anyone; grocery_spender resets dependents only. */
router.post(
  '/reset-pin',
  requireAuth,
  ah(async (req, res) => {
    const { userId, newPin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const normalized = normalizePin(newPin);
    if (!normalized) return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });

    const target = await User.findById(userId).select('+pinHash');
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const { canResetPinFor } = require('./helpers');
    if (!canResetPinFor(req.user.role, target.role)) {
      return res.status(403).json({ error: 'You do not have permission to reset that PIN.' });
    }

    target.pinHash = await bcrypt.hash(normalized, BCRYPT_ROUNDS);
    target.failedAttempts = 0;
    target.lockedUntil = null;
    await target.save();

    await logActivity({
      familyId: target.familyId,
      actor: req.user,
      type: 'pin_reset',
      subjectUserId: target._id,
      message: `${req.user.name} reset ${target.name}'s PIN.`,
    });
    res.json({ ok: true, user: target.toSafeJSON() });
  })
);

/** POST /api/auth/biometric — toggle biometric unlock for the authenticated user. */
router.post(
  '/biometric',
  requireAuth,
  ah(async (req, res) => {
    const { enabled } = req.body || {};
    req.user.biometricEnabled = Boolean(enabled);
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  })
);

/** POST /api/auth/logout — invalidate the refresh token. */
router.post(
  '/logout',
  requireAuth,
  ah(async (req, res) => {
    req.user.refreshTokenHash = null;
    await req.user.save();
    res.json({ ok: true });
  })
);

/**
 * PATCH /api/auth/photo — set a member's profile photo (small data URL).
 * Anyone can set their own photo; provider/grocery_spender can set anyone's.
 */
router.patch(
  '/photo',
  requireAuth,
  ah(async (req, res) => {
    const { userId, avatarPhoto } = req.body || {};
    const targetId = userId ? String(userId) : String(req.user._id);
    const isSelf = targetId === String(req.user._id);
    if (!isSelf && !canFundAnyone(req.user.role)) {
      return res.status(403).json({ error: 'Only the provider and grocery spender can change other people’s photos.' });
    }

    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    // null / empty string clears the photo; anything else must be a small data URL
    if (avatarPhoto === null || avatarPhoto === '') {
      target.avatarPhoto = null;
      await target.save();
      return res.json({ user: target.toSafeJSON() });
    }
    if (avatarPhoto === undefined) {
      return res.status(400).json({ error: 'avatarPhoto is required.' });
    }
    if (
      typeof avatarPhoto !== 'string' ||
      !avatarPhoto.startsWith('data:image/') ||
      avatarPhoto.length > 1024 * 1024 // ~750 KB decoded — avatars are small
    ) {
      return res.status(400).json({ error: 'Photo must be a data URL under ~750 KB. Pick a smaller picture.' });
    }

    target.avatarPhoto = avatarPhoto;
    await target.save();
    res.json({ user: target.toSafeJSON() });
  })
);

/**
 * POST /api/auth/factory-reset — wipe the whole family back to brand-new.
 * Requires the master reset PIN (default 0259, override via FACTORY_RESET_PIN).
 * Everything is deleted: money records, shops, catalog, checklist, budgets,
 * bills, goals, activity — and every member's PIN (so everyone sets a fresh
 * one on first open). Members, roles and default categories are kept.
 */
router.post(
  '/factory-reset',
  resetLimiter,
  ah(async (req, res) => {
    const { pin } = req.body || {};
    if (String(pin || '').trim() !== FACTORY_RESET_PIN) {
      return res.status(403).json({ error: 'That reset PIN is not correct.' });
    }

    const models = require('../models');
    const { Family, TrackingPeriod, GroceryBalance, PersonalBalance, Category } = models;

    const family = await Family.findOne().sort({ createdAt: 1 });
    if (!family) return res.status(409).json({ error: 'No family found to reset.' });

    // --- wipe every piece of data (keep Family + User documents) ---
    const wipe = [
      models.FundingTransaction,
      models.ExpenseTransaction,
      models.Shop,
      models.ActivityLog,
      models.GroceryChecklistItem,
      models.GroceryCatalogItem,
      models.CategoryBudget,
      models.RecurringBill,
      models.SavingsGoal,
      models.Shoutout,
      models.PinNote,
      models.Chore,
      models.MealPlan,
      TrackingPeriod,
      GroceryBalance,
      PersonalBalance,
    ];
    for (const M of wipe) await M.deleteMany({});
    await Category.deleteMany({ familyId: family._id });

    // --- reset every member to brand-new (no PIN, no biometric, no photo) ---
    await User.updateMany(
      {},
      {
        $set: {
          pinHash: null,
          refreshTokenHash: null,
          biometricEnabled: false,
          avatarPhoto: null,
          failedAttempts: 0,
          lockedUntil: null,
        },
      }
    );

    // --- fresh tracking period + zero balances + default categories ---
    const now = new Date();
    const period = await TrackingPeriod.create({
      familyId: family._id,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      status: 'active',
    });
    await GroceryBalance.create({ familyId: family._id, periodId: period._id, funded: 0, spent: 0, budgetAmount: 0 });
    const users = await User.find({ familyId: family._id });
    for (const u of users) {
      await PersonalBalance.create({ userId: u._id, periodId: period._id, funded: 0, spent: 0, fundedBy: [] });
    }
    const DEFAULT_CATEGORIES = [
      'Groceries', 'Meat & Fish', 'Vegetables & Fruits', 'Dairy & Eggs', 'Petrol',
      'Restaurant & Eat Out', 'Pharmacy & Health', 'Utility Bills', 'Transport',
      'Education', 'Entertainment', 'Household', 'Personal Care', 'Other',
    ];
    await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ familyId: family._id, name })));

    res.json({
      ok: true,
      message: 'Housely has been reset to brand-new. Every member starts fresh with a new PIN.',
    });
  })
);

module.exports = router;
