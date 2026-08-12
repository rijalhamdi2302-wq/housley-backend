/**
 * Housely — demo data seed (OPTIONAL).
 * Adds sample shops, transactions across the last few periods, catalog items,
 * checklist items, recurring bills and savings goals so charts & analytics are
 * fun to explore while testing.
 *
 *   npm run seed:demo
 *
 * Requires `npm run seed` to have run first. Safe: it does nothing if any
 * expenses already exist, and every demo transaction can be deleted from the
 * app (Transaction History → delete), which also fixes the balances.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const {
  Family,
  User,
  TrackingPeriod,
  GroceryBalance,
  PersonalBalance,
  ExpenseTransaction,
  FundingTransaction,
  Shop,
  GroceryCatalogItem,
  GroceryChecklistItem,
  RecurringBill,
  SavingsGoal,
  ActivityLog,
} = require('./models');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI missing in backend/.env');
  process.exit(1);
}

const dayOffset = (base, days, hour = 10) =>
  new Date(new Date(base).getTime() + days * 86400000).setHours(hour, 30, 0, 0);

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✓ Connected to MongoDB');

  const family = await Family.findOne();
  if (!family) {
    console.error('✗ No family found. Run `npm run seed` first.');
    process.exit(1);
  }
  if ((await ExpenseTransaction.countDocuments({ familyId: family._id })) > 0) {
    console.log('ℹ Expenses already exist — demo data skipped (keeps your data clean).');
    return;
  }

  const users = await User.find({ familyId: family._id });
  const byRole = Object.fromEntries(users.map((u) => [u.role, u]));

  // Backfill the fixed family order (dad → mom → Rijal → Faten → Alya)
  const NAME_ORDER = [
    'Asyraf Bin Md Rusli',
    'Noraini Binti Abdul Wahab',
    'Rijal Hamdi Bin Asyraf',
    'Faten Arij Binti Asyraf',
    'Alya Izzati Binti Asyraf',
  ];
  for (const u of users) {
    const order = NAME_ORDER.indexOf(u.name) + 1 || 99;
    if (u.sortOrder !== order) {
      u.sortOrder = order;
      await u.save();
    }
  }
  const [dad, mom, rijal, faten, alya] = [
    byRole.provider,
    byRole.grocery_spender,
    byRole.member,
    ...users.filter((u) => u.role === 'dependent'),
  ];

  // --- Activity logging (so the notification bell has a life) -----------------
  const logAct = (actor, type, subjectUserId, message, amount = 0, meta = {}) =>
    ActivityLog.create({
      familyId: family._id,
      actorId: actor._id,
      actorName: actor.name,
      type,
      subjectUserId: subjectUserId || null,
      message,
      amount,
      meta,
    });

  // --- Shops ------------------------------------------------------------------
  const shopDefs = [
    { name: 'Econsave', type: 'groceries', cat: 'Groceries' },
    { name: "Lotus's", type: 'groceries', cat: 'Groceries' },
    { name: 'Pasar Pagi', type: 'groceries', cat: 'Vegetables & Fruits' },
    { name: 'NSK Trade City', type: 'groceries', cat: 'Groceries' },
    { name: 'Speedmart 99', type: 'groceries', cat: 'Groceries' },
    { name: 'Petronas', type: 'petrol', cat: 'Petrol' },
    { name: 'Shell', type: 'petrol', cat: 'Petrol' },
    { name: 'Restoran Kak Zah', type: 'restaurant', cat: 'Restaurant & Eat Out' },
    { name: 'Klinik Dr. Amir', type: 'pharmacy', cat: 'Pharmacy & Health' },
    { name: 'Pharmaniaga', type: 'pharmacy', cat: 'Pharmacy & Health' },
  ];
  const shops = {};
  for (const s of shopDefs) {
    const doc = await Shop.create({ familyId: family._id, ...s, usageCount: 0, learnedCategory: s.cat });
    shops[s.name] = doc;
  }
  console.log('✓ Shops created');

  // --- Past periods (3 closed months) -------------------------------------------
  const now = new Date();
  for (let back = 3; back >= 1; back--) {
    const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 0, 23, 59, 59, 999);
    const period = await TrackingPeriod.create({
      familyId: family._id,
      startDate: start,
      endDate: end,
      status: 'closed',
      closedAt: end,
    });

    const gb = await GroceryBalance.create({
      familyId: family._id,
      periodId: period._id,
      funded: 150000,
      spent: 128000 + back * 5000,
      budgetAmount: 150000,
    });
    await FundingTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'groceries',
      userId: dad._id,
      fundedById: dad._id,
      amount: 150000,
      paymentMethod: 'online_banking',
      note: 'Monthly groceries top-up',
    });
    for (const u of users) {
      await PersonalBalance.create({
        userId: u._id,
        periodId: period._id,
        funded: u.role === 'dependent' ? 10000 : 20000,
        spent: 0,
        fundedBy: [],
      });
    }
    // A few grocery trips per past period
    const trips = [
      { shop: 'Econsave', amt: 46500 + back * 1500, day: 3, who: mom },
      { shop: "Lotus's", amt: 38200 + back * 1200, day: 9, who: mom },
      { shop: 'Pasar Pagi', amt: 12800, day: 13, who: rijal },
      { shop: 'Petronas', amt: 6000 + back * 800, day: 17, who: dad },
      { shop: 'Restoran Kak Zah', amt: 2200, day: 21, who: rijal },
      { shop: 'Klinik Dr. Amir', amt: 1500, day: 25, who: mom },
    ];
    for (const t of trips) {
      const shop = shops[t.shop];
      await ExpenseTransaction.create({
        familyId: family._id,
        periodId: period._id,
        type: 'groceries',
        userId: t.who._id,
        spentById: t.who._id,
        shopId: shop._id,
        shopName: shop.name,
        category: shop.learnedCategory,
        amount: t.amt,
        paymentMethod: t.amt > 10000 ? 'credit_card' : 'cash',
        createdAt: dayOffset(start, t.day - 1, 11),
      });
      shop.usageCount += 1;
      await shop.save();
      await logAct(t.who, 'groceries_spent', null, `${t.who.name} spent ${(t.amt / 100).toFixed(2)} at ${shop.name}.`, t.amt, { shop: shop.name });
    }
    console.log(`✓ Past period ${start.toISOString().slice(0, 7)} created`);
  }

  // --- Current period -------------------------------------------------------------
  const period = await TrackingPeriod.findOne({ familyId: family._id, status: 'active' });
  const gb = await GroceryBalance.findOne({ familyId: family._id, periodId: period._id });
  gb.funded = 200000;
  gb.budgetAmount = 180000;
  await gb.save();

  const fundTx = await FundingTransaction.create({
    familyId: family._id,
    periodId: period._id,
    type: 'groceries',
    userId: dad._id,
    fundedById: dad._id,
    amount: 200000,
    paymentMethod: 'online_banking',
    note: 'Groceries fund for this month',
  });
  await logAct(dad, 'groceries_funded', null, `${dad.name} topped up Groceries with ${(fundTx.amount / 100).toFixed(2)}.`, fundTx.amount);

  const curTrips = [
    { shop: 'Econsave', amt: 52300, day: 2, who: mom, items: ['Sunny Queen eggs', 'Ayam brand rice', 'Milo', 'Nestum'] },
    { shop: 'Pasar Pagi', amt: 14600, day: 4, who: mom, items: ['Cili padi', 'Kangkung', 'Bawang merah', 'Tomato'] },
    { shop: 'Petronas', amt: 6800, day: 6, who: dad },
    { shop: "Lotus's", amt: 38900, day: 8, who: mom, items: ['Dutch Lady milk', 'Gardenia bread', 'Kit Kat', 'Downy'] },
    { shop: 'Speedmart 99', amt: 3450, day: 10, who: rijal, items: ['Mamee', 'Coca-Cola'] },
    { shop: 'Restoran Kak Zah', amt: 2650, day: 11, who: rijal },
  ];
  let curSpent = 0;
  for (const t of curTrips) {
    const shop = shops[t.shop];
    const lineItems = (t.items || []).map((name, i) => ({
      name,
      quantity: i % 2 === 0 ? 2 : 1,
      unitPrice: Math.round(t.amt / 100 / (t.items?.length || 1) / 100) * 100,
      totalPrice: 0,
    }));
    // simpler: give each item the same share
    if (lineItems.length) {
      const share = Math.floor(t.amt / lineItems.length);
      for (const li of lineItems) li.totalPrice = share;
    }
    await ExpenseTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'groceries',
      userId: t.who._id,
      spentById: t.who._id,
      shopId: shop._id,
      shopName: shop.name,
      category: shop.learnedCategory,
      amount: t.amt,
      paymentMethod: t.amt > 10000 ? 'credit_card' : 'cash',
      lineItems,
      createdAt: dayOffset(period.startDate, t.day - 1, 12),
    });
    shop.usageCount += 1;
    await shop.save();
    curSpent += t.amt;
    const itemNames = (t.items || []).slice(0, 5);
    await logAct(
      t.who,
      'groceries_spent',
      null,
      `${t.who.name} spent ${(t.amt / 100).toFixed(2)} at ${shop.name}${itemNames.length ? ' · ' + itemNames.join(', ') : ''}.`,
      t.amt,
      { shop: shop.name, items: itemNames }
    );
  }
  gb.spent = curSpent;
  await gb.save();

  // Personal balances for this period
  for (const u of users) {
    const pb = await PersonalBalance.findOneAndUpdate(
      { userId: u._id, periodId: period._id },
      { $setOnInsert: { funded: 0, spent: 0, fundedBy: [] } },
      { upsert: true, new: true }
    );
    const fundAmount = u.role === 'dependent' ? 10000 : 20000;
    if (!pb.funded) {
      pb.funded = fundAmount;
      pb.fundedBy.push({ userId: dad._id, amount: fundAmount, at: new Date() });
      await FundingTransaction.create({
        familyId: family._id,
        periodId: period._id,
        type: 'personal',
        userId: u._id,
        fundedById: dad._id,
        amount: fundAmount,
        paymentMethod: 'cash',
        note: 'Monthly allowance',
      });
      await logAct(dad, 'personal_funded', u._id, `${dad.name} funded ${u.name}'s personal balance with ${(fundAmount / 100).toFixed(2)}.`, fundAmount, { targetName: u.name, targetRole: u.role });
    }
    const spent = u.role === 'dependent' ? 3400 : 6200;
    pb.spent = spent;
    await pb.save();
    const pShop = u.role === 'dependent' ? 'Kedai Runcit' : 'Speedmart 99';
    await ExpenseTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'personal',
      userId: u._id,
      spentById: u._id,
      shopName: pShop,
      category: u.role === 'dependent' ? 'Entertainment' : 'Transport',
      amount: spent,
      paymentMethod: 'cash',
      note: 'Pocket money',
      createdAt: dayOffset(period.startDate, 6, 16),
    });
    await logAct(u, 'personal_spent', u._id, `${u.name} spent ${(spent / 100).toFixed(2)} at ${pShop} from their personal balance.`, spent, { shop: pShop });
  }

  // --- Catalog ---------------------------------------------------------------------
  const catalogItems = [
    ['Ayam brand rice', 'Groceries'],
    ['Sunny Queen eggs', 'Dairy & Eggs'],
    ['Dutch Lady milk', 'Dairy & Eggs'],
    ['Gardenia bread', 'Groceries'],
    ['Milo', 'Groceries'],
    ['Nestum', 'Groceries'],
    ['Cili padi', 'Vegetables & Fruits'],
    ['Kangkung', 'Vegetables & Fruits'],
    ['Bawang merah', 'Vegetables & Fruits'],
    ['Tomato', 'Vegetables & Fruits'],
    ['Mamee', 'Groceries'],
    ['Coca-Cola', 'Groceries'],
    ['Downy', 'Household'],
  ];
  for (const [name, cat] of catalogItems) {
    await GroceryCatalogItem.create({
      familyId: family._id,
      name,
      category: cat,
      stockStatus: ['Kangkung', 'Milo', 'Mamee'].includes(name) ? 'low' : 'in_stock',
      timesBought: 2 + Math.floor(Math.random() * 6),
      lastBoughtAt: new Date(),
    });
  }

  // --- Checklist ---------------------------------------------------------------------
  await GroceryChecklistItem.create({
    familyId: family._id,
    name: 'Ayam brand rice 5kg',
    quantity: '1 bag',
    createdById: mom._id,
  });
  await GroceryChecklistItem.create({
    familyId: family._id,
    name: 'Gardenia wholemeal',
    quantity: '2',
    createdById: rijal._id,
  });
  await GroceryChecklistItem.create({
    familyId: family._id,
    name: 'Telur Gred B',
    quantity: '1 tray',
    createdById: faten._id,
  });

  // --- Bills --------------------------------------------------------------------------
  const today = new Date().getDate();
  const bills = [
    { name: 'TNB Electricity', expectedAmount: 18000, dueDayOfMonth: 15, category: 'Utility Bills' },
    { name: 'WiFi (Unifi)', expectedAmount: 12900, dueDayOfMonth: 20, category: 'Utility Bills' },
    { name: 'Water (Air Selangor)', expectedAmount: 3200, dueDayOfMonth: 25, category: 'Utility Bills' },
    { name: 'Astro', expectedAmount: 9900, dueDayOfMonth: 28, category: 'Entertainment' },
  ];
  for (const b of bills) {
    await RecurringBill.create({
      familyId: family._id,
      name: b.name,
      expectedAmount: b.expectedAmount,
      dueDayOfMonth: b.dueDayOfMonth,
      category: b.category,
      lastPaidAt: b.dueDayOfMonth < today ? new Date(now.getFullYear(), now.getMonth(), b.dueDayOfMonth) : null,
    });
  }

  // --- Goals ----------------------------------------------------------------------------
  await SavingsGoal.create({
    familyId: family._id,
    name: 'Family holiday to Langkawi',
    targetAmount: 300000,
    currentAmount: 120000,
    emoji: '🏝️',
  });
  await SavingsGoal.create({
    familyId: family._id,
    name: 'New school shoes',
    targetAmount: 15000,
    currentAmount: 15000,
    reached: true,
    reachedAt: new Date(),
    emoji: '👟',
  });
  await SavingsGoal.create({
    familyId: family._id,
    name: 'Emergency fund cushion',
    targetAmount: 500000,
    currentAmount: 200000,
    emoji: '🛟',
  });

  console.log('✓ Demo data created — open the app and explore!');
  console.log('  Tip: delete any demo transaction in Transaction History to remove it (balances fix themselves).');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('✗ Demo seed failed:', err);
  process.exit(1);
});
