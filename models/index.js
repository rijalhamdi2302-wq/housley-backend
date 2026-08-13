/**
 * Housely — single-file Mongoose data model
 * Every schema for the whole family money app lives here.
 */

const mongoose = require('mongoose');

/** Helper: money stored in sen (1/100 of a ringgit) as an integer — avoids float drift. */
const money = {
  type: Number,
  required: true,
  min: 0,
  default: 0,
  get: (v) => v, // raw integer, frontend formats
};

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------
const familySchema = new mongoose.Schema(
  {
    name: { type: String, default: "The Asyraf Family" },
    periodType: { type: String, enum: ['monthly', 'weekly', 'annually'], default: 'monthly' },
    rolloverPolicy: { type: String, enum: ['carry_forward', 'reset'], default: 'carry_forward' },
    currency: { type: String, default: 'RM' },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------
const userSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['provider', 'grocery_spender', 'member', 'dependent'],
      required: true,
    },
    sortOrder: { type: Number, default: 99, min: 1 }, // fixed family order (dad → mom → rijal → sisters)
    pinHash: { type: String, default: null, select: false },
    biometricEnabled: { type: Boolean, default: false },
    avatarColor: { type: String, default: '#ff6f91' },
    avatarPhoto: { type: String, default: null }, // small base64 data URL — the member's own photo
    // Provider-set max a member may spend from Groceries in one trip (sen; 0 = unlimited)
    groceryTripLimit: { type: Number, default: 0, min: 0 },
    // PIN lockout fields
    failedAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    // Hashed long-lived refresh token used for biometric unlock
    refreshTokenHash: { type: String, default: null, select: false },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  return {
    _id: this._id,
    name: this.name,
    role: this.role,
    avatarColor: this.avatarColor,
    avatarPhoto: this.avatarPhoto || null,
    hasPin: Boolean(this.pinHash),
    biometricEnabled: Boolean(this.biometricEnabled),
    groceryTripLimit: this.groceryTripLimit || 0,
  };
};

// ---------------------------------------------------------------------------
// TrackingPeriod
// ---------------------------------------------------------------------------
const trackingPeriodSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
trackingPeriodSchema.index({ familyId: 1, status: 1 });

// ---------------------------------------------------------------------------
// GroceryBalance — one per family per period
// ---------------------------------------------------------------------------
const groceryBalanceSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    funded: money,
    spent: money,
    budgetAmount: money, // provider-set spending target (distinct from funded)
  },
  { timestamps: true }
);
groceryBalanceSchema.index({ familyId: 1, periodId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// PersonalBalance — one per user per period
// ---------------------------------------------------------------------------
const funderEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: money,
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const personalBalanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    funded: money,
    spent: money,
    fundedBy: [funderEntrySchema], // who contributed and how much
  },
  { timestamps: true }
);
personalBalanceSchema.index({ userId: 1, periodId: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// FundingTransaction — money in
// ---------------------------------------------------------------------------
const fundingTransactionSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    type: { type: String, enum: ['groceries', 'personal'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // target (groceries: whole family / personal: this user)
    fundedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // who did it
    amount: money,
    paymentMethod: {
      type: String,
      enum: ['online_banking', 'cash', 'credit_card', 'e_wallet'],
      required: true,
    },
    proofImage: { type: String, default: null }, // base64 data URL — required only for online_banking
    note: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// ExpenseTransaction — money out (with optional line items)
// ---------------------------------------------------------------------------
const lineItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: Number, default: 1, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const expenseTransactionSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    type: { type: String, enum: ['groceries', 'personal'], required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // whose balance it comes from
    spentById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // who logged it
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    shopName: { type: String, trim: true, default: '' }, // denormalized so history works even if shop deleted
    category: { type: String, trim: true, maxlength: 60, default: 'Other' },
    amount: { type: Number, required: true, min: 0 },
    paymentMethod: {
      type: String,
      enum: ['online_banking', 'cash', 'credit_card', 'e_wallet'],
      default: 'cash',
    },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    receiptImage: { type: String, default: null }, // optional base64 data URL — proof of the purchase
    lineItems: { type: [lineItemSchema], default: [] },
    flags: {
      type: [String],
      default: [],
      enum: ['unusual', 'duplicate'],
    },
    imported: { type: Boolean, default: false },
  },
  { timestamps: true }
);
expenseTransactionSchema.index({ familyId: 1, periodId: 1 });
expenseTransactionSchema.index({ spentById: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Shop
// ---------------------------------------------------------------------------
const shopSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: {
      type: String,
      enum: ['groceries', 'meat', 'petrol', 'restaurant', 'pharmacy', 'utility', 'other'],
      default: 'other',
    },
    aliases: { type: [String], default: [] },
    usageCount: { type: Number, default: 0, min: 0 },
    learnedCategory: { type: String, trim: true, maxlength: 60, default: '' },
  },
  { timestamps: true }
);
shopSchema.index({ familyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// ActivityLog — append-only feed, powers the notification stream
// ---------------------------------------------------------------------------
const activityLogSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorName: { type: String, default: '' },
    type: {
      type: String,
      enum: [
        'groceries_funded',
        'groceries_spent',
        'personal_funded',
        'personal_spent',
        'pin_set',
        'pin_reset',
        'period_closed',
        'period_opened',
        'goal_contributed',
        'goal_reached',
        'bill_paid',
        'checklist_bought',
        'catalog_updated',
        'expense_edited',
        'expense_deleted',
        'funding_deleted',
        'chore_approved',
        'shoutout',
        'roundup_saved',
        'period_under_budget',
      ],
      required: true,
    },
    subjectUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // the person the event is ABOUT
    message: { type: String, required: true, trim: true, maxlength: 500 },
    amount: { type: Number, default: 0 },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);
activityLogSchema.index({ familyId: 1, createdAt: -1 });
activityLogSchema.index({ subjectUserId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// GroceryChecklistItem
// ---------------------------------------------------------------------------
const groceryChecklistItemSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    quantity: { type: String, trim: true, maxlength: 40, default: '1' },
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    checked: { type: Boolean, default: false },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// GroceryCatalogItem — the family's memory of every known grocery item
// ---------------------------------------------------------------------------
const groceryCatalogItemSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, trim: true, maxlength: 60, default: 'Other' },
    stockStatus: { type: String, enum: ['in_stock', 'low', 'out'], default: 'in_stock' },
    barcode: { type: String, trim: true, maxlength: 32, default: '' }, // EAN-13 / UPC etc.
    timesBought: { type: Number, default: 0, min: 0 },
    lastBoughtAt: { type: Date, default: null },
  },
  { timestamps: true }
);
groceryCatalogItemSchema.index({ familyId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: 'string', $ne: '' } } });
groceryCatalogItemSchema.index({ familyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------
const categorySchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
  },
  { timestamps: true }
);
categorySchema.index({ familyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// CategoryBudget — per period, per category
// ---------------------------------------------------------------------------
const categoryBudgetSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrackingPeriod', required: true, index: true },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    budgetAmount: money,
  },
  { timestamps: true }
);
categoryBudgetSchema.index({ familyId: 1, periodId: 1, category: 1 }, { unique: true });

// ---------------------------------------------------------------------------
// RecurringBill
// ---------------------------------------------------------------------------
const recurringBillSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    expectedAmount: money,
    dueDayOfMonth: { type: Number, required: true, min: 1, max: 31 },
    category: { type: String, trim: true, maxlength: 60, default: 'Utility Bills' },
    lastPaidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// SavingsGoal — standalone aspirational tracker
// ---------------------------------------------------------------------------
const goalContributionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: 1 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const savingsGoalSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    targetAmount: { type: Number, required: true, min: 1 },
    currentAmount: { type: Number, default: 0, min: 0 },
    reached: { type: Boolean, default: false },
    reachedAt: { type: Date, default: null },
    emoji: { type: String, default: '🎯' },
    // #24 savings together — who contributed what (powers the leaderboard)
    contributions: { type: [goalContributionSchema], default: [] },
    // #25 birthday & event funds — an optional date the family is saving toward
    type: { type: String, enum: ['normal', 'event'], default: 'normal' },
    eventDate: { type: Date, default: null },
    // #6 round-up savings — spare change from expenses lands here automatically
    isRoundup: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ---------------------------------------------------------------------------
// MealPlan — weekly dinner plans (feature #15)
// ---------------------------------------------------------------------------
const mealPlanSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    date: { type: Date, required: true }, // calendar day (YYYY-MM-DD at midnight)
    meal: { type: String, enum: ['dinner', 'lunch', 'breakfast'], default: 'dinner' },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    emoji: { type: String, default: '🍲' },
    ingredients: { type: [String], default: [] }, // free-text ingredient lines
    note: { type: String, trim: true, maxlength: 200, default: '' },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);
mealPlanSchema.index({ familyId: 1, date: 1 });

// ---------------------------------------------------------------------------
// Chore — chore-to-allowance (feature #19)
// ---------------------------------------------------------------------------
const choreSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 100 },
    emoji: { type: String, default: '🧹' },
    reward: { type: Number, required: true, min: 1 }, // sen paid on approval
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'done', 'approved'], default: 'pending' },
    completedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
choreSchema.index({ familyId: 1, status: 1, assignedTo: 1 });

// ---------------------------------------------------------------------------
// Shoutout — family thank-you feed (feature #21)
// ---------------------------------------------------------------------------
const shoutoutSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 300 },
    emoji: { type: String, default: '💛' },
    reacts: {
      type: [{ emoji: { type: String }, userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] }],
      default: [],
    },
  },
  { timestamps: true }
);
shoutoutSchema.index({ familyId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// PinNote — family noticeboard (feature #22)
// ---------------------------------------------------------------------------
const pinNoteSchema = new mongoose.Schema(
  {
    familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true, index: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 300 },
    color: { type: String, default: '#ffe3e9' },
  },
  { timestamps: true }
);
pinNoteSchema.index({ familyId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Register & export
// ---------------------------------------------------------------------------
module.exports = {
  Family: mongoose.model('Family', familySchema),
  User: mongoose.model('User', userSchema),
  TrackingPeriod: mongoose.model('TrackingPeriod', trackingPeriodSchema),
  GroceryBalance: mongoose.model('GroceryBalance', groceryBalanceSchema),
  PersonalBalance: mongoose.model('PersonalBalance', personalBalanceSchema),
  FundingTransaction: mongoose.model('FundingTransaction', fundingTransactionSchema),
  ExpenseTransaction: mongoose.model('ExpenseTransaction', expenseTransactionSchema),
  Shop: mongoose.model('Shop', shopSchema),
  ActivityLog: mongoose.model('ActivityLog', activityLogSchema),
  GroceryChecklistItem: mongoose.model('GroceryChecklistItem', groceryChecklistItemSchema),
  GroceryCatalogItem: mongoose.model('GroceryCatalogItem', groceryCatalogItemSchema),
  Category: mongoose.model('Category', categorySchema),
  CategoryBudget: mongoose.model('CategoryBudget', categoryBudgetSchema),
  RecurringBill: mongoose.model('RecurringBill', recurringBillSchema),
  SavingsGoal: mongoose.model('SavingsGoal', savingsGoalSchema),
  MealPlan: mongoose.model('MealPlan', mealPlanSchema),
  Chore: mongoose.model('Chore', choreSchema),
  Shoutout: mongoose.model('Shoutout', shoutoutSchema),
  PinNote: mongoose.model('PinNote', pinNoteSchema),
};
