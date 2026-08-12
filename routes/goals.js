/**
 * Housely — savings goals routes.
 * Standalone aspirational tracker, deliberately NOT wired into the real
 * Groceries/Personal balances — the family updates it manually.
 */

const express = require('express');
const { SavingsGoal } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, isValidMoney, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** GET /api/goals */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily();
    const goals = await SavingsGoal.find({ familyId: family._id }).sort({ createdAt: -1 });
    res.json({ goals });
  })
);

/** POST /api/goals — add a goal. */
router.post(
  '/',
  ah(async (req, res) => {
    const { name, targetAmount, emoji } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Goal name is required.' });
    if (!isValidMoney(targetAmount) || targetAmount <= 0) {
      return res.status(400).json({ error: 'A valid target amount is required.' });
    }
    const family = await getFamily();
    const goal = await SavingsGoal.create({
      familyId: family._id,
      name: clean.slice(0, 80),
      targetAmount,
      emoji: String(emoji || '🎯').slice(0, 8),
    });
    res.status(201).json({ goal });
  })
);

/** PATCH /api/goals/:id/contribute — add money toward the goal. */
router.patch(
  '/:id/contribute',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const { amount } = req.body || {};
    if (!isValidMoney(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A valid contribution amount is required.' });
    }
    const family = await getFamily();
    const goal = await SavingsGoal.findOne({ _id: id, familyId: family._id });
    if (!goal) return res.status(404).json({ error: 'Goal not found.' });

    goal.currentAmount += amount;
    if (goal.currentAmount >= goal.targetAmount && !goal.reached) {
      goal.currentAmount = goal.targetAmount;
      goal.reached = true;
      goal.reachedAt = new Date();
      await goal.save();
      await logActivity({
        familyId: family._id,
        actor: req.user,
        type: 'goal_reached',
        message: `🎉 ${req.user.name} reached the savings goal "${goal.name}"!`,
        amount: goal.targetAmount,
        meta: { goal: goal.name },
      });
      return res.json({ goal, reachedNow: true });
    }
    await goal.save();
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'goal_contributed',
      message: `${req.user.name} added ${(amount / 100).toFixed(2)} to "${goal.name}".`,
      amount,
      meta: { goal: goal.name },
    });
    res.json({ goal, reachedNow: false });
  })
);

/** DELETE /api/goals/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily();
    const goal = await SavingsGoal.findOne({ _id: id, familyId: family._id });
    if (!goal) return res.status(404).json({ error: 'Goal not found.' });
    await SavingsGoal.deleteOne({ _id: goal._id });
    res.json({ ok: true });
  })
);

module.exports = router;
