/**
 * Housely — grocery catalog routes.
 * The family's memory of every item ever bought, with stock status.
 */

const express = require('express');
const { GroceryCatalogItem } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** GET /api/catalog — every known item (frontend groups by category). */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily();
    const items = await GroceryCatalogItem.find({ familyId: family._id }).sort({
      category: 1,
      name: 1,
    });
    res.json({ items });
  })
);

/** GET /api/catalog/favorites — most-bought items as quick chips. */
router.get(
  '/favorites',
  ah(async (req, res) => {
    const family = await getFamily();
    const items = await GroceryCatalogItem.find({ familyId: family._id })
      .sort({ timesBought: -1 })
      .limit(10);
    res.json({ items });
  })
);

/** POST /api/catalog — manually add an item not yet in the catalog. */
router.post(
  '/',
  ah(async (req, res) => {
    const { name, category } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Item name is required.' });
    const family = await getFamily();
    const existing = await GroceryCatalogItem.findOne({
      familyId: family._id,
      name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' },
    });
    if (existing) return res.status(409).json({ error: 'That item is already in the catalog.', item: existing });
    const item = await GroceryCatalogItem.create({
      familyId: family._id,
      name: clean.slice(0, 120),
      category: String(category || '').trim().slice(0, 60) || 'Other',
      stockStatus: 'in_stock',
    });
    res.status(201).json({ item });
  })
);

/** PATCH /api/catalog/:id — update stock status / category. */
router.patch(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily();
    const item = await GroceryCatalogItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Catalog item not found.' });

    const { stockStatus, category } = req.body || {};
    if (stockStatus !== undefined) {
      if (!['in_stock', 'low', 'out'].includes(stockStatus)) {
        return res.status(400).json({ error: 'Invalid stock status.' });
      }
      item.stockStatus = stockStatus;
    }
    if (typeof category === 'string' && category.trim()) {
      item.category = category.trim().slice(0, 60);
    }
    await item.save();
    res.json({ item });
  })
);

/** DELETE /api/catalog/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily();
    const item = await GroceryCatalogItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Catalog item not found.' });
    await GroceryCatalogItem.deleteOne({ _id: item._id });
    res.json({ ok: true });
  })
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
