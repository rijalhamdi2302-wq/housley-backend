/**
 * Housely — seed script.
 * Creates the family, the 5 members with their fixed roles, the first tracking
 * period, starting balances and the default category list.
 *
 *   npm run seed
 *
 * Idempotent: safe to run multiple times — it skips work that already exists.
 * The builder (Rijal Hamdi Bin Asyraf) is seeded with PIN 2302 as requested.
 * Everyone else has no PIN yet and creates their own on first open.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const {
  Family,
  User,
  TrackingPeriod,
  GroceryBalance,
  PersonalBalance,
  Category,
} = require('./models');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI missing in backend/.env');
  process.exit(1);
}

const MEMBERS = [
  { name: 'Asyraf Bin Md Rusli', role: 'provider', color: '#4e9de6', pin: null, bio: false, order: 1 },
  { name: 'Noraini Binti Abdul Wahab', role: 'grocery_spender', color: '#f39ac2', pin: null, bio: false, order: 2 },
  { name: 'Rijal Hamdi Bin Asyraf', role: 'member', color: '#7c5cd6', pin: '2302', bio: false, order: 3 },
  { name: 'Faten Arij Binti Asyraf', role: 'dependent', color: '#f7b32b', pin: null, bio: false, order: 4 },
  { name: 'Alya Izzati Binti Asyraf', role: 'dependent', color: '#6fcf97', pin: null, bio: false, order: 5 },
];

/** Family order for the picker — dad, mom, Rijal, Faten, Alya. */
const NAME_ORDER = [
  'Asyraf Bin Md Rusli',
  'Noraini Binti Abdul Wahab',
  'Rijal Hamdi Bin Asyraf',
  'Faten Arij Binti Asyraf',
  'Alya Izzati Binti Asyraf',
];

/** Idempotent: backfills sortOrder on an already-seeded database too. */
async function ensureSortOrders() {
  const users = await User.find({}).select('name sortOrder');
  let changed = 0;
  for (const u of users) {
    const idx = NAME_ORDER.indexOf(u.name);
    const order = idx >= 0 ? idx + 1 : 99;
    if (!u.sortOrder || u.sortOrder !== order) {
      u.sortOrder = order;
      await u.save();
      changed += 1;
    }
  }
  if (changed) console.log(`  ↻ Backfilled sort order for ${changed} member(s).`);
}

const DEFAULT_CATEGORIES = [
  'Groceries',
  'Meat & Fish',
  'Vegetables & Fruits',
  'Dairy & Eggs',
  'Petrol',
  'Restaurant & Eat Out',
  'Pharmacy & Health',
  'Utility Bills',
  'Transport',
  'Education',
  'Entertainment',
  'Household',
  'Personal Care',
  'Other',
];

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  console.log('✓ Connected to MongoDB');

  // Wipe everything (destructive!) when --wipe is passed
  if (process.argv.includes('--wipe')) {
    const cols = await mongoose.connection.db.collections();
    for (const col of cols) await col.drop();
    console.log('⚠ Wiped all existing collections.');
  }

  const existing = await Family.countDocuments();
  if (existing > 0) {
    // Still keep the family member order right on an existing database.
    await ensureSortOrders();
    console.log('ℹ A family already exists — skipping. (Run `npm run seed:demo` for sample data.)');
    return;
  }

  const family = await Family.create({
    name: 'The Asyraf Family',
    periodType: 'monthly',
    rolloverPolicy: 'carry_forward',
    currency: 'RM',
  });

  const users = [];
  for (const m of MEMBERS) {
    const pinHash = m.pin ? await bcrypt.hash(m.pin, 12) : null;
    const u = await User.create({
      familyId: family._id,
      name: m.name,
      role: m.role,
      sortOrder: m.order,
      avatarColor: m.color,
      pinHash,
      biometricEnabled: m.bio,
    });
    users.push(u);
    console.log(`  ✓ ${m.name} (${m.role})${m.pin ? ' — PIN 2302 set' : ' — no PIN yet'}`);
  }

  const now = new Date();
  const period = await TrackingPeriod.create({
    familyId: family._id,
    startDate: new Date(now.getFullYear(), now.getMonth(), 1),
    endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    status: 'active',
  });

  await GroceryBalance.create({
    familyId: family._id,
    periodId: period._id,
    funded: 0,
    spent: 0,
    budgetAmount: 0,
  });
  for (const u of users) {
    await PersonalBalance.create({
      userId: u._id,
      periodId: period._id,
      funded: 0,
      spent: 0,
      fundedBy: [],
    });
  }

  await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ familyId: family._id, name })));

  console.log('✓ Seeded family, members, first period, balances and default categories.');
  console.log('  Tip: log in as Rijal with PIN 2302, or open any other profile to create its PIN.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('✗ Seed failed:', err);
  process.exit(1);
});
