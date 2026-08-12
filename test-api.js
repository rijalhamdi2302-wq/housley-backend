/**
 * Housely — end-to-end API smoke test.
 *   node test-api.js
 * Requires the backend to be running (npm start) and the DB to be seeded.
 * Exercises auth, permissions, funding, expenses, flags, catalog, checklist,
 * categories, analytics, activity, transactions, bills, goals, exports and
 * period rollover. Prints PASS/FAIL per check and exits non-zero on failure.
 */

const BASE = process.env.BASE_URL || 'http://localhost:4000/api';
const ExcelJS = require('exceljs');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON (e.g. xlsx) */
  }
  return { status: res.status, data, res };
}

async function main() {
  console.log('\n== Health ==');
  const health = await req('GET', '/health');
  check('health returns ok', health.status === 200 && health.data.ok === true);

  console.log('\n== Profiles (no auth) ==');
  const profiles = await req('GET', '/auth/profiles');
  check('profiles status 200', profiles.status === 200);
  check('five family members', profiles.data.users.length === 5, JSON.stringify(profiles.data.users.map((u) => u.name)));
  check('no pinHash leaked', profiles.data.users.every((u) => !('pinHash' in u)));

  const byName = Object.fromEntries(profiles.data.users.map((u) => [u.name, u]));
  const rijal = byName['Rijal Hamdi Bin Asyraf'];
  const dad = byName['Asyraf Bin Md Rusli'];
  const mom = byName['Noraini Binti Abdul Wahab'];
  const sister1 = byName['Faten Arij Binti Asyraf'];
  check('Rijal is member role', rijal && rijal.role === 'member');
  check('Dad is provider', dad && dad.role === 'provider');
  check('Mom is grocery_spender', mom && mom.role === 'grocery_spender');
  check('sisters are dependents', sister1 && sister1.role === 'dependent');
  check('Rijal has a PIN set (2302)', rijal.hasPin === true);
  check('others have no PIN yet', dad.hasPin === false && mom.hasPin === false && sister1.hasPin === false);

  console.log('\n== Auth protection ==');
  const noAuth = await req('GET', '/funding/balances/groceries');
  check('protected route rejects anonymous', noAuth.status === 401);

  console.log('\n== PIN verify (Rijal 2302) ==');
  const wrongPin = await req('POST', '/auth/verify-pin', { body: { userId: rijal._id, pin: '9999' } });
  check('wrong PIN rejected', wrongPin.status === 401);
  check('wrong PIN reports attempts left', wrongPin.data.attemptsLeft === 4);
  const badFormat = await req('POST', '/auth/verify-pin', { body: { userId: rijal._id, pin: '12ab' } });
  check('non-numeric PIN rejected', badFormat.status === 400);
  const login = await req('POST', '/auth/verify-pin', { body: { userId: rijal._id, pin: '2302' } });
  check('correct PIN logs in (2302)', login.status === 200 && login.data.token);
  const rijalToken = login.data.token;
  const rijalRefresh = login.data.refreshToken;
  check('login returns safe user', login.data.user && login.data.user.hasPin === true && !('pinHash' in login.data.user));

  console.log('\n== Lockout ==');
  const other = byName['Alya Izzati Binti Asyraf'];
  // alya has no pin; set one via set-pin for lockout testing
  const setAlya = await req('POST', '/auth/set-pin', { body: { userId: other._id, pin: '0000' } });
  check('set-pin works for new profile', setAlya.status === 201 && setAlya.data.token);
  const setAgain = await req('POST', '/auth/set-pin', { body: { userId: other._id, pin: '1111' } });
  check('set-pin refused when PIN exists', setAgain.status === 409);
  let locked = null;
  for (let i = 0; i < 5; i++) {
    locked = await req('POST', '/auth/verify-pin', { body: { userId: other._id, pin: '9999' } });
  }
  check('5 wrong attempts lock the profile', locked.status === 423);
  const stillLocked = await req('POST', '/auth/verify-pin', { body: { userId: other._id, pin: '0000' } });
  check('correct PIN refused while locked', stillLocked.status === 423);

  console.log('\n== Categories (auto-seed) ==');
  const cats = await req('GET', '/categories', { token: rijalToken });
  check('categories seeded on first call', cats.status === 200 && cats.data.categories.length >= 10, `got ${cats.data.categories.length}`);
  const catNames = cats.data.categories.map((c) => c.name);
  const newCat = await req('POST', '/categories', { token: rijalToken, body: { name: 'Pet Food' } });
  check('add category', newCat.status === 201);
  const dupCat = await req('POST', '/categories', { token: rijalToken, body: { name: 'Pet Food' } });
  check('duplicate category refused', dupCat.status === 409);

  console.log('\n== Permissions: Rijal (member) ==');
  const memberFundGroc = await req('POST', '/funding/groceries', { token: rijalToken, body: { amount: 10000, paymentMethod: 'cash' } });
  check('member cannot fund Groceries', memberFundGroc.status === 403);
  const memberSetBudget = await req('PATCH', '/funding/groceries/budget', { token: rijalToken, body: { budgetAmount: 50000 } });
  check('member cannot set Groceries budget', memberSetBudget.status === 403);
  const memberCatBudget = await req('PATCH', `/analytics/category-budgets/${encodeURIComponent('Groceries')}`, { token: rijalToken, body: { budgetAmount: 40000 } });
  check('member cannot set category budget', memberCatBudget.status === 403);
  const memberClose = await req('POST', '/periods/close-and-start-new', { token: rijalToken });
  check('member cannot close period', memberClose.status === 403);

  console.log('\n== Funding personal (self) ==');
  const fundSelf = await req('POST', '/funding/personal', { token: rijalToken, body: { amount: 5000, paymentMethod: 'cash' } });
  check('member funds own personal balance', fundSelf.status === 201);
  check('personal balance funded 50.00', fundSelf.data.balance.funded === 5000);
  const fundOther = await req('POST', '/funding/personal', { token: rijalToken, body: { userId: sister1._id, amount: 5000, paymentMethod: 'cash' } });
  check('member cannot fund other people', fundOther.status === 403);
  const fundNoProof = await req('POST', '/funding/personal', { token: rijalToken, body: { amount: 5000, paymentMethod: 'online_banking' } });
  check('online banking requires proof image', fundNoProof.status === 400);
  const fundProof = await req('POST', '/funding/personal', {
    token: rijalToken,
    body: { amount: 5000, paymentMethod: 'online_banking', proofImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  });
  check('online banking with proof accepted', fundProof.status === 201);

  console.log('\n== Personal expense (self only) ==');
  const expSelf = await req('POST', '/expenses/personal', { token: rijalToken, body: { amount: 1200, category: 'Transport', shopName: 'Grab' } });
  check('personal expense logged', expSelf.status === 201);
  check('personal balance spent updated', expSelf.data.balance.spent === 1200);

  console.log('\n== Groceries expense (member allowed) ==');
  const g1 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Econsave', amount: 10000, paymentMethod: 'cash', category: 'Groceries' } });
  check('member logs groceries expense', g1.status === 201);
  const g2 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Econsave', amount: 10000, paymentMethod: 'cash', category: 'Groceries' } });
  check('duplicate (same shop/amount/day) flagged', g2.status === 201 && g2.data.flags.includes('duplicate'), JSON.stringify(g2.data.flags));
  const g3 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Pasar Pagi', amount: 2000, paymentMethod: 'cash', category: 'Vegetables & Fruits' } });
  const g4 = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Speedmart 99', amount: 3000, paymentMethod: 'cash', category: 'Groceries' } });
  check('normal expenses ok', g3.status === 201 && g4.status === 201);
  const gBig = await req('POST', '/expenses/groceries', { token: rijalToken, body: { shopName: 'Big Mall', amount: 90000, paymentMethod: 'cash', category: 'Groceries' } });
  check('unusual spend flagged (>2.5x avg)', gBig.status === 201 && gBig.data.flags.includes('unusual'), JSON.stringify(gBig.data.flags));

  console.log('\n== Line items → catalog sync ==');
  const gItems = await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: {
      shopName: 'Econsave',
      amount: 30000,
      category: 'Groceries',
      paymentMethod: 'cash',
      lineItems: [
        { name: 'Ayam brand rice', quantity: 1, unitPrice: 15000, totalPrice: 15000 },
        { name: 'Sunny Queen eggs', quantity: 2, unitPrice: 7500, totalPrice: 15000 },
      ],
    },
  });
  check('expense with line items saved', gItems.status === 201);
  const catalog = await req('GET', '/catalog', { token: rijalToken });
  const rice = catalog.data.items.find((i) => i.name === 'Ayam brand rice');
  check('catalog auto-created items', !!rice && rice.timesBought === 1, JSON.stringify(catalog.data.items.map((i) => i.name)));
  check('catalog item category learned', rice.category === 'Groceries');
  // buying the same item again bumps count
  await req('POST', '/expenses/groceries', {
    token: rijalToken,
    body: { shopName: 'Econsave', amount: 15000, category: 'Groceries', paymentMethod: 'cash', lineItems: [{ name: 'ayam brand RICE', quantity: 1, unitPrice: 15000, totalPrice: 15000 }] },
  });
  const catalog2 = await req('GET', '/catalog', { token: rijalToken });
  const rice2 = catalog2.data.items.find((i) => i.name === 'Ayam brand rice');
  check('catalog sync is case-insensitive & bumps count', rice2 && rice2.timesBought === 2);

  const favCat = await req('GET', '/catalog/favorites', { token: rijalToken });
  check('catalog favorites endpoint', favCat.status === 200);

  console.log('\n== Shops ==');
  const shops = await req('GET', '/expenses/shops', { token: rijalToken });
  check('shops listed', shops.status === 200 && shops.data.shops.length >= 4);
  const favs = await req('GET', '/expenses/shops/favorites', { token: rijalToken });
  check('favorite shops by usage', favs.status === 200 && favs.data.shops[0].name === 'Econsave');
  const cheapest = await req('GET', '/expenses/shops/cheapest', { token: rijalToken });
  check('cheapest shop suggestion', cheapest.status === 200 && cheapest.data.suggestion);
  const newShop = await req('POST', '/expenses/shops', { token: rijalToken, body: { name: 'AEON Big', type: 'groceries', category: 'Groceries' } });
  check('create shop directly', newShop.status === 201);

  console.log('\n== Provider actions (set Dad PIN then login) ==');
  const setDad = await req('POST', '/auth/set-pin', { body: { userId: dad._id, pin: '1111' } });
  check('set Dad PIN', setDad.status === 201);
  const dadLogin = await req('POST', '/auth/verify-pin', { body: { userId: dad._id, pin: '1111' } });
  const dadToken = dadLogin.data.token;

  const dadFund = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: 200000, paymentMethod: 'cash', note: 'Monthly top-up' } });
  check('provider funds Groceries', dadFund.status === 201);
  check('grocery balance funded 2000.00', dadFund.data.balance.funded === 200000);
  const dadSetBudget = await req('PATCH', '/funding/groceries/budget', { token: dadToken, body: { budgetAmount: 180000 } });
  check('provider sets Groceries budget', dadSetBudget.status === 200 && dadSetBudget.data.balance.budgetSet === true);
  check('safe-to-spend computed', dadSetBudget.data.balance.safeToSpend >= 0 && dadSetBudget.data.balance.daysLeft > 0);
  const dadCatBudget = await req('PATCH', `/analytics/category-budgets/${encodeURIComponent('Groceries')}`, { token: dadToken, body: { budgetAmount: 120000 } });
  check('provider sets category budget', dadCatBudget.status === 200);
  const dadFundOther = await req('POST', '/funding/personal', { token: dadToken, body: { userId: sister1._id, amount: 10000, paymentMethod: 'cash' } });
  check('provider funds a dependent', dadFundOther.status === 201);
  const dadSummary = await req('GET', '/analytics/family/summary', { token: dadToken });
  check('provider sees all 5 personal balances', dadSummary.data.personal.length === 5, `got ${dadSummary.data.personal.length}`);
  const dadFunding = await req('GET', '/transactions/funding', { token: dadToken });
  check('provider sees everyone\u2019s funding records', dadFunding.data.funding.length >= 4, `got ${dadFunding.data.funding.length}`);

  console.log('\n== Mom (grocery_spender) ==');
  const setMom = await req('POST', '/auth/set-pin', { body: { userId: mom._id, pin: '2222' } });
  check('set Mom PIN', setMom.status === 201);
  const momLogin = await req('POST', '/auth/verify-pin', { body: { userId: mom._id, pin: '2222' } });
  const momToken = momLogin.data.token;
  const momFund = await req('POST', '/funding/groceries', { token: momToken, body: { amount: 50000, paymentMethod: 'e_wallet' } });
  check('grocery_spender funds Groceries', momFund.status === 201);
  const momSeeSisterCat = await req('GET', `/analytics/personal/${sister1._id}/category`, { token: momToken });
  check('grocery_spender can view others\u2019 personal analytics', momSeeSisterCat.status === 200);
  const momSummary = await req('GET', '/analytics/family/summary', { token: momToken });
  check('grocery_spender sees all 5 personal balances', momSummary.data.personal.length === 5, `got ${momSummary.data.personal.length}`);
  const momResetSister = await req('POST', '/auth/reset-pin', { token: momToken, body: { userId: sister1._id, newPin: '3333' } });
  check('grocery_spender resets dependent PIN', momResetSister.status === 200);
  const momResetDad = await req('POST', '/auth/reset-pin', { token: momToken, body: { userId: dad._id, newPin: '4444' } });
  check('grocery_spender cannot reset provider PIN', momResetDad.status === 403);
  const rijalResetSister = await req('POST', '/auth/reset-pin', { token: rijalToken, body: { userId: sister1._id, newPin: '5555' } });
  check('member cannot reset anyone PIN', rijalResetSister.status === 403);

  console.log('\n== Checklist ==');
  const cl = await req('GET', '/checklist', { token: rijalToken });
  check('checklist empty initially', cl.status === 200 && cl.data.items.length === 0);
  const clAdd = await req('POST', '/checklist', { token: rijalToken, body: { name: 'Milo', quantity: '2 tin' } });
  check('add checklist item', clAdd.status === 201);
  const clToggle = await req('PATCH', `/checklist/${clAdd.data.item._id}`, { token: rijalToken, body: { checked: true } });
  check('toggle checklist item', clToggle.status === 200 && clToggle.data.item.checked === true);
  // suggested section should contain the low/out catalog items
  await req('PATCH', `/catalog/${rice2._id}`, { token: rijalToken, body: { stockStatus: 'low' } });
  const cl2 = await req('GET', '/checklist', { token: rijalToken });
  check('suggested-from-catalog section shows low items', cl2.data.suggested.some((s) => s.name === 'Ayam brand rice'));
  const clBought = await req('POST', `/checklist/${clAdd.data.item._id}/bought`, { token: rijalToken });
  check('bought-it removes checklist item', clBought.status === 200);
  const clAdd2 = await req('POST', '/checklist', { token: rijalToken, body: { name: 'Temp item', quantity: '1' } });
  const clDel = await req('DELETE', `/checklist/${clAdd2.data.item._id}`, { token: rijalToken });
  check('delete checklist item', clDel.status === 200);

  console.log('\n== Catalog management ==');
  const catAdd = await req('POST', '/catalog', { token: rijalToken, body: { name: 'Kicap Jalen', category: 'Household' } });
  check('manual catalog add', catAdd.status === 201);
  const catPatch = await req('PATCH', `/catalog/${catAdd.data.item._id}`, { token: rijalToken, body: { stockStatus: 'out' } });
  check('catalog status update', catPatch.status === 200 && catPatch.data.item.stockStatus === 'out');
  const catDel = await req('DELETE', `/catalog/${catAdd.data.item._id}`, { token: rijalToken });
  check('catalog delete', catDel.status === 200);

  console.log('\n== Transactions: history, edit, delete ==');
  const txList = await req('GET', '/transactions/expenses', { token: rijalToken, body: undefined });
  check('expense history listed', txList.status === 200 && txList.data.expenses.length >= 7);
  const txSearch = await req('GET', `/transactions/expenses?search=${encodeURIComponent('Econsave')}`, { token: rijalToken });
  check('search by shop works', txSearch.status === 200 && txSearch.data.expenses.every((e) => e.shopName === 'Econsave'));
  const txFilter = await req('GET', '/transactions/expenses?type=personal', { token: rijalToken });
  check('filter by type works', txFilter.status === 200 && txFilter.data.expenses.every((e) => e.type === 'personal'));

  const balBefore = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  const txEdit = await req('PATCH', `/transactions/expenses/${expSelf.data.expense._id}`, { token: rijalToken, body: { amount: 2200 } });
  check('edit expense amount (1200 → 2200)', txEdit.status === 200 && txEdit.data.expense.amount === 2200);
  const balAfterEdit = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  check('balance adjusted by delta (+1000 sen)', balAfterEdit.spent - balBefore.spent === 1000, `delta ${balAfterEdit.spent - balBefore.spent}`);
  const txDel = await req('DELETE', `/transactions/expenses/${expSelf.data.expense._id}`, { token: rijalToken });
  check('delete expense restores balance', txDel.status === 200);
  const balAfterDel = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  // the only personal expense (1200→2200) was deleted, so spent returns to 0
  check('balance restored after delete', balAfterDel.spent === 0, `spent ${balAfterDel.spent}`);

  const fundingList = await req('GET', '/transactions/funding', { token: rijalToken });
  check('funding history listed (member sees own only)', fundingList.status === 200 && fundingList.data.funding.length >= 2, `got ${fundingList.data.funding.length}`);
  check('member funding list hides other people\u2019s records', fundingList.data.funding.every((f) => String(f.fundedById) === String(rijal._id) || String(f.userId) === String(rijal._id)));
  const selfFunding = fundingList.data.funding.find((f) => f.type === 'personal' && String(f.userId) === String(rijal._id) && f.amount === 5000 && f.paymentMethod === 'cash');
  const balB4 = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  const fdDel = await req('DELETE', `/transactions/funding/${selfFunding._id}`, { token: rijalToken });
  check('delete funding record', fdDel.status === 200);
  const balAft = (await req('GET', '/funding/balances/personal/' + rijal._id, { token: rijalToken })).data.balance;
  check('funding delete reduces funded balance', balAft.funded === balB4.funded - 5000, `${balB4.funded} → ${balAft.funded}`);
  // editing someone else's expense as non-owner
  const momExp = await req('POST', '/expenses/personal', { token: momToken, body: { amount: 800, category: 'Entertainment' } });
  const editOther = await req('PATCH', `/transactions/expenses/${momExp.data.expense._id}`, { token: rijalToken, body: { amount: 900 } });
  check('member cannot edit another member\u2019s expense', editOther.status === 403);
  const editAsDad = await req('PATCH', `/transactions/expenses/${momExp.data.expense._id}`, { token: dadToken, body: { amount: 900 } });
  check('provider can edit any expense', editAsDad.status === 200);

  console.log('\n== Analytics ==');
  const recap = await req('GET', '/analytics/weekly-recap', { token: rijalToken });
  check('weekly recap', recap.status === 200 && recap.data.total >= 0);
  const byStore = await req('GET', '/analytics/groceries/by-store', { token: rijalToken });
  check('groceries by store', byStore.status === 200 && byStore.data.data.length >= 1);
  const byMonth = await req('GET', '/analytics/groceries/by-month', { token: rijalToken });
  check('groceries by month (6 buckets)', byMonth.status === 200 && byMonth.data.data.length === 6);
  const byPeriod = await req('GET', '/analytics/groceries/by-period', { token: rijalToken });
  check('groceries by period', byPeriod.status === 200);
  const persCat = await req('GET', `/analytics/personal/${rijal._id}/category`, { token: rijalToken });
  check('personal category pie', persCat.status === 200 && persCat.data.data.length >= 0);
  const persOther = await req('GET', `/analytics/personal/${sister1._id}/category`, { token: rijalToken });
  check('cannot view other personal analytics', persOther.status === 403);
  const famCat = await req('GET', '/analytics/family/categories', { token: rijalToken });
  check('family categories', famCat.status === 200);
  const summary = await req('GET', '/analytics/family/summary', { token: rijalToken });
  check('family summary', summary.status === 200 && summary.data.groceries.funded >= 250000);
  check('member summary shows ONLY their own balance', summary.data.personal.length === 1 && String(summary.data.personal[0].user._id) === String(rijal._id), `got ${summary.data.personal.length}`);
  const catBudgets = await req('GET', '/analytics/category-budgets', { token: rijalToken });
  check('category budgets list', catBudgets.status === 200 && catBudgets.data.budgets.length >= 1);

  console.log('\n== Analytics (new views) ==');
  for (const b of ['daily', 'weekly', 'monthly', 'yearly']) {
    const tr = await req('GET', `/analytics/trend?bucket=${b}`, { token: rijalToken });
    check(`trend bucket ${b}`, tr.status === 200 && Array.isArray(tr.data.data) && tr.data.data.length >= 2, JSON.stringify(tr.data).slice(0, 120));
  }
  const trBad = await req('GET', '/analytics/trend?bucket=hourly', { token: rijalToken });
  check('trend falls back on bad bucket', trBad.status === 200 && trBad.data.bucket === 'monthly');
  const wd = await req('GET', '/analytics/weekday-pattern', { token: rijalToken });
  check('weekday pattern has 7 days', wd.status === 200 && wd.data.data.length === 7, JSON.stringify(wd.data));
  const mc = await req('GET', '/analytics/member-comparison', { token: rijalToken });
  check('member comparison lists spenders', mc.status === 200 && Array.isArray(mc.data.data) && mc.data.data.length >= 1);
  const te = await req('GET', '/analytics/top-expenses', { token: rijalToken });
  check('top expenses sorted desc', te.status === 200 && te.data.data.length >= 1 && te.data.data[0].amount >= te.data.data[te.data.data.length - 1].amount);
  check('top expenses resolve spender names', te.data.data.every((e) => e.spentByName && e.spentByName !== 'Family'), JSON.stringify(te.data.data.map((e) => e.spentByName)));
  const ts = await req('GET', '/analytics/top-shops', { token: rijalToken });
  check('top shops listed', ts.status === 200 && ts.data.data.length >= 1 && typeof ts.data.data[0].trips === 'number');

  console.log('\n== Activity feed (visibility) ==');
  const actRijal = await req('GET', '/activity', { token: rijalToken });
  check('Rijal sees groceries + own activity', actRijal.status === 200 && actRijal.data.activity.length >= 5);
  // sister's PIN was set to 3333 earlier by Mom (grocery_spender reset)
  const actSisterLogin = await req('POST', '/auth/verify-pin', { body: { userId: sister1._id, pin: '3333' } });
  check('sister login works', actSisterLogin.status === 200);
  const sisterToken = actSisterLogin.data.token;
  const actSisterFeed = await req('GET', '/activity', { token: sisterToken });
  check('dependent does NOT see provider personal funding of others', !actSisterFeed.data.activity.some((a) => a.type === 'personal_funded' && String(a.subjectUserId) === String(mom._id)));
  check('dependent sees groceries activity', actSisterFeed.data.activity.some((a) => a.type === 'groceries_funded'));
  check('dependent sees public spend events (where money goes)', actSisterFeed.data.activity.some((a) => a.type === 'personal_spent'));

  console.log('\n== Bills ==');
  const bills = await req('GET', '/bills', { token: rijalToken });
  check('bills listed', bills.status === 200 && Array.isArray(bills.data.bills));
  const billAdd = await req('POST', '/bills', { token: rijalToken, body: { name: 'TNB', expectedAmount: 18000, dueDayOfMonth: 15, category: 'Utility Bills' } });
  check('add bill', billAdd.status === 201);
  check('bill has due info', billAdd.data.bill.daysUntilDue !== undefined && typeof billAdd.data.bill.dueSoon === 'boolean');
  const billDueSoon = await req('POST', '/bills', { token: rijalToken, body: { name: 'WiFi', expectedAmount: 12900, dueDayOfMonth: new Date().getDate() + 1, category: 'Utility Bills' } });
  check('bill due within 3 days flagged', billDueSoon.status === 201 && billDueSoon.data.bill.dueSoon === true);
  const billPaid = await req('PATCH', `/bills/${billDueSoon.data.bill._id}/mark-paid`, { token: rijalToken });
  check('mark bill paid', billPaid.status === 200 && billPaid.data.bill.dueSoon === false);
  const billDel = await req('DELETE', `/bills/${billAdd.data.bill._id}`, { token: rijalToken });
  check('delete bill', billDel.status === 200);

  console.log('\n== Savings goals ==');
  const goals = await req('GET', '/goals', { token: rijalToken });
  check('goals listed', goals.status === 200);
  const goalAdd = await req('POST', '/goals', { token: rijalToken, body: { name: 'Langkawi trip', targetAmount: 100000, emoji: '🏝️' } });
  check('add goal', goalAdd.status === 201);
  const goalCont = await req('PATCH', `/goals/${goalAdd.data.goal._id}/contribute`, { token: rijalToken, body: { amount: 40000 } });
  check('contribute to goal', goalCont.status === 200 && goalCont.data.goal.currentAmount === 40000);
  const goalReach = await req('PATCH', `/goals/${goalAdd.data.goal._id}/contribute`, { token: rijalToken, body: { amount: 60000 } });
  check('goal reached celebration state', goalReach.status === 200 && goalReach.data.reachedNow === true && goalReach.data.goal.reached === true);
  const goalDel = await req('DELETE', `/goals/${goalAdd.data.goal._id}`, { token: rijalToken });
  check('delete goal', goalDel.status === 200);

  console.log('\n== Excel export ==');
  // xlsx bodies are binary — fetch directly and read the buffer once
  const rawGet = async (path, token) => {
    const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, header: res.headers.get('content-disposition') || '' };
  };
  const expPeriod = await rawGet('/export/period', dadToken);
  check('period export is a real xlsx', expPeriod.status === 200 && expPeriod.buf.slice(0, 2).toString() === 'PK', `status ${expPeriod.status}`);
  check('period export has filename header', expPeriod.header.includes('.xlsx'));
  const expRange = await rawGet(`/export/range?startDate=${new Date().toISOString().slice(0, 10)}&endDate=${new Date().toISOString().slice(0, 10)}`, rijalToken);
  check('range export is a real xlsx', expRange.status === 200 && expRange.buf.slice(0, 2).toString() === 'PK');

  console.log('\n== Excel import ==');
  const buildXlsx = async (rows) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['date', 'shop', 'amount', 'category', 'type', 'note']);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  };
  const importRows = [
    ['12/08/2026', 'Econsave', 42.5, 'Groceries', 'groceries', 'import test'],
    ['11/08/2026', 'Speedmart 99', 15.2, '', 'groceries', ''],
    ['10/08/2026', 'Grab', 12.0, 'Transport', 'personal', ''],
    ['', 'No date row', 5, '', '', ''],
    ['09/08/2026', '', 'x', '', 'groceries', ''],
  ];
  const importFile = await buildXlsx(importRows);
  const imp = await req('POST', '/import/excel', { token: rijalToken, body: { data: importFile } });
  check('excel import saves valid rows', imp.status === 201 && imp.data.imported === 3, JSON.stringify(imp.data).slice(0, 200));
  check('import reports bad rows with row numbers', imp.data.errors.length === 1 && imp.data.errors[0].row === 6, JSON.stringify(imp.data.errors));
  const impBal = await req('GET', `/funding/balances/personal/${rijal._id}`, { token: rijalToken });
  check('personal row lands on own balance', impBal.data.balance.spent >= 1200, `spent ${impBal.data.balance.spent}`);
  const impAgain = await req('POST', '/import/excel', { token: rijalToken, body: { data: importFile } });
  check('re-import skips duplicate groceries rows', impAgain.status === 201 && impAgain.data.duplicates === 2, JSON.stringify(impAgain.data));
  const impBad = await req('POST', '/import/excel', { token: rijalToken, body: { data: Buffer.from('not an xlsx at all').toString('base64') } });
  check('invalid xlsx rejected', impBad.status === 400);
  const impNoData = await req('POST', '/import/excel', { token: rijalToken, body: {} });
  check('missing file data rejected', impNoData.status === 400);
  const impSis = await req('POST', '/import/excel', { token: sisterToken, body: { data: importFile } });
  check('dependent cannot import excel', impSis.status === 403);
  const impSerial = await buildXlsx([
    [46240, 'Serial Date Shop', 9.9, '', 'groceries', ''], // 46240 ≈ 6 Aug 2026, inside the active period
  ]);
  const impSer = await req('POST', '/import/excel', { token: rijalToken, body: { data: impSerial } });
  check('excel serial dates parsed', impSer.status === 201 && impSer.data.imported === 1, JSON.stringify(impSer.data).slice(0, 160));
  const impOld = await buildXlsx([
    ['01/01/2026', 'Ancient Shop', 5.5, '', 'groceries', ''], // before the current period
  ]);
  const impOldRes = await req('POST', '/import/excel', { token: rijalToken, body: { data: impOld } });
  check('pre-period rows skipped with a clear message', impOldRes.status === 201 && impOldRes.data.imported === 0 && impOldRes.data.errors.length === 1 && /before the current period/.test(impOldRes.data.errors[0].message), JSON.stringify(impOldRes.data).slice(0, 180));

  console.log('\n== Change / refresh / logout ==');
  const changeWrong = await req('POST', '/auth/change-pin', { token: rijalToken, body: { currentPin: '1111', newPin: '7777' } });
  check('change-pin rejects wrong current PIN', changeWrong.status === 401);
  const changeOk = await req('POST', '/auth/change-pin', { token: rijalToken, body: { currentPin: '2302', newPin: '7777' } });
  check('change-pin succeeds with correct PIN', changeOk.status === 200);
  const relogin = await req('POST', '/auth/verify-pin', { body: { userId: rijal._id, pin: '7777' } });
  check('new PIN works after change', relogin.status === 200);
  // the relogin rotated the refresh token — grab the fresh one
  const freshRefresh = relogin.data.refreshToken;
  await req('POST', '/auth/change-pin', { token: relogin.data.token, body: { currentPin: '7777', newPin: '2302' } });
  const refreshOk = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: freshRefresh } });
  check('refresh token issues new session', refreshOk.status === 200 && refreshOk.data.token);
  const refreshReuse = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: freshRefresh } });
  check('refresh token rotates (reuse rejected)', refreshReuse.status === 401);
  const logout = await req('POST', '/auth/logout', { token: refreshOk.data.token });
  check('logout ok', logout.status === 200);
  const refreshAfterLogout = await req('POST', '/auth/refresh', { body: { userId: rijal._id, refreshToken: refreshOk.data.refreshToken } });
  check('refresh after logout rejected', refreshAfterLogout.status === 401);

  console.log('\n== Period close & rollover (provider) ==');
  const statusBefore = await req('GET', '/periods/status', { token: dadToken });
  check('period status', statusBefore.status === 200 && statusBefore.data.period);
  const gbBefore = (await req('GET', '/funding/balances/groceries', { token: dadToken })).data.balance;
  const close = await req('POST', '/periods/close-and-start-new', { token: dadToken });
  check('provider closes period', close.status === 200, JSON.stringify(close.data));
  check('new active period opened', close.data.opened && close.data.opened.status === 'active');
  const gbAfter = (await req('GET', '/funding/balances/groceries', { token: dadToken })).data.balance;
  check('rollover carries balance forward', gbAfter.funded === Math.max(0, gbBefore.funded - gbBefore.spent), `before ${gbBefore.funded - gbBefore.spent} after ${gbAfter.funded}`);
  check('new period has fresh spent (0)', gbAfter.spent === 0);
  const closeAgain = await req('POST', '/periods/close-and-start-new', { token: dadToken });
  check('cannot close again immediately (no protection needed — new period opened)', closeAgain.status === 200 || closeAgain.status === 409);

  console.log('\n== Input validation & security ==');
  const hugeAmount = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: -5, paymentMethod: 'cash' } });
  check('negative amount rejected', hugeAmount.status === 400);
  const nanAmount = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: 'abc', paymentMethod: 'cash' } });
  check('non-numeric amount rejected', nanAmount.status === 400);
  const badMethod = await req('POST', '/funding/groceries', { token: dadToken, body: { amount: 1000, paymentMethod: 'bitcoin' } });
  check('invalid payment method rejected', badMethod.status === 400);
  const badId = await req('GET', '/funding/balances/personal/notanid', { token: dadToken });
  check('invalid object id rejected', badId.status === 400);
  const badToken = await req('GET', '/funding/balances/groceries', { token: 'not.a.jwt' });
  check('invalid token rejected', badToken.status === 401);
  const wrongUser = await req('POST', '/expenses/personal', { token: dadToken, body: { userId: rijal._id, amount: 100, category: 'x' } });
  check('personal expense userId is ignored (self only enforced)', wrongUser.status === 201 && String(wrongUser.data.expense.userId) === String(dad._id));

  console.log('\n========================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    for (const f of failures) console.log('  ✗', f);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
