/**
 * Housely — family settings routes (feature #37).
 * Provider can change the family name, the tracking period type
 * (monthly / weekly / annually) and the rollover policy from Settings —
 * no reseeding needed. Changing the period type opens a fresh tracking
 * period sized for the new type and rolls current balances into it.
 */

const express = require('express');
const { Family, TrackingPeriod, PersonalBalance } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, getActivePeriod, getGroceryBalance, getPersonalBalance, requireObjectId } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

function nextPeriodDates(periodType, startDate) {
  const start = new Date(startDate);
  let end;
  if (periodType === 'weekly') {
    end = new Date(start.getTime() + 6 * 86400000);
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }
  if (periodType === 'annually') {
    end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate() - 1, 23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }
  end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
  return { startDate: start, endDate: end };
}

/**
 * PATCH /api/family/limits/:userId — provider sets a member's per-trip
 * Groceries spending limit (feature #23). 0 clears it (unlimited).
 */
router.patch(
  '/limits/:userId',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can set spending limits.' });
    }
    const { User } = require('../models');
    const target = await User.findById(requireObjectId(req.params.userId, 'userId'));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const { groceryTripLimit } = req.body || {};
    if (!Number.isInteger(groceryTripLimit) || groceryTripLimit < 0 || groceryTripLimit > 1_000_000_00) {
      return res.status(400).json({ error: 'Limit must be a whole number of sen (0 = unlimited).' });
    }
    target.groceryTripLimit = groceryTripLimit;
    await target.save();
    res.json({ user: target.toSafeJSON(), groceryTripLimit: target.groceryTripLimit });
  })
);

/** GET /api/family — current family settings. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily();
    res.json({
      family: {
        name: family.name,
        periodType: family.periodType,
        rolloverPolicy: family.rolloverPolicy,
        currency: family.currency,
        aiEnabled: family.aiEnabled !== false,
      },
    });
  })
);

/** PATCH /api/family — update name / periodType / rolloverPolicy (provider only). */
router.patch(
  '/',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can change family settings.' });
    }
    const family = await Family.findOne().sort({ createdAt: 1 });
    const { name, periodType, rolloverPolicy, aiEnabled } = req.body || {};

    if (name !== undefined) {
      const clean = String(name || '').trim();
      if (!clean) return res.status(400).json({ error: 'Family name cannot be empty.' });
      family.name = clean.slice(0, 60);
    }
    if (periodType !== undefined) {
      if (!['monthly', 'weekly', 'annually'].includes(periodType)) {
        return res.status(400).json({ error: 'Period type must be monthly, weekly or annually.' });
      }
      if (periodType !== family.periodType) {
        // Close the current period and open a fresh one sized for the new type.
        const active = await getActivePeriod(family._id);
        if (active) {
          active.status = 'closed';
          active.closedAt = new Date();
          await active.save();

          const dates = nextPeriodDates(periodType, new Date());
          const next = await TrackingPeriod.create({
            familyId: family._id,
            startDate: dates.startDate,
            endDate: dates.endDate,
            status: 'active',
          });

          // Roll balances forward into the fresh period
          const gb = await getGroceryBalance(family._id, active._id);
          const leftover = Math.max(0, (gb ? gb.funded : 0) - (gb ? gb.spent : 0));
          const newGb = await getGroceryBalance(family._id, next._id);
          newGb.funded = family.rolloverPolicy === 'carry_forward' ? leftover : 0;
          newGb.spent = 0;
          if (gb && gb.budgetAmount > 0) newGb.budgetAmount = gb.budgetAmount;
          await newGb.save();

          const personalBalances = await PersonalBalance.find({ periodId: active._id });
          for (const pb of personalBalances) {
            const pLeftover = Math.max(0, pb.funded - pb.spent);
            const npb = await getPersonalBalance(pb.userId, next._id);
            npb.funded = family.rolloverPolicy === 'carry_forward' ? pLeftover : 0;
            npb.spent = 0;
            npb.fundedBy = [];
            await npb.save();
          }
          family._periodRebuilt = { closed: active._id, opened: next._id };
        }
        family.periodType = periodType;
      }
    }
    if (rolloverPolicy !== undefined) {
      if (!['carry_forward', 'reset'].includes(rolloverPolicy)) {
        return res.status(400).json({ error: 'Rollover policy must be carry_forward or reset.' });
      }
      family.rolloverPolicy = rolloverPolicy;
    }
    if (aiEnabled !== undefined) {
      family.aiEnabled = Boolean(aiEnabled);
    }

    await family.save();
    res.json({
      family: {
        name: family.name,
        periodType: family.periodType,
        rolloverPolicy: family.rolloverPolicy,
        currency: family.currency,
        aiEnabled: family.aiEnabled !== false,
      },
      periodRebuilt: family._periodRebuilt || null,
    });
  })
);

module.exports = router;
