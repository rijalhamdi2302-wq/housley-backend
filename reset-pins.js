// One-off: clear every family member's PIN so the app is truly brand new.
require('dotenv').config();
const mongoose = require('mongoose');
const { User } = require('./models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const r = await User.updateMany(
    {},
    {
      $unset: { pinHash: 1 },
      $set: { failedAttempts: 0, lockedUntil: null, refreshTokenHash: null, biometricEnabled: false },
    }
  );
  console.log(`Cleared PINs on ${r.modifiedCount} user(s).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
