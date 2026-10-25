// Sets the plan lengths on an EXISTING database: Basic 3 days, Standard 5 days, Premium 7 days.
//   npm run plans:days
// (New databases get these automatically. You can also change them any time in Admin > Plans.)
require('dotenv').config();
require('../src/config');
const connect = require('../src/db');
const { Plan } = require('../src/models');
(async () => {
  await connect();
  for (const [key, days] of [['basic', 3], ['standard', 5], ['premium', 7]]) {
    const r = await Plan.updateOne({ key }, { durationDays: days });
    console.log(`${key}: ${r.matchedCount ? days + ' days' : 'plan not found'}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
