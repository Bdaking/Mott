// Creates the first admin. Safe to run again.
const bcrypt = require('bcryptjs');
require('./config');
const connect = require('./db');
const { Admin } = require('./models');

(async () => {
  await connect();
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 10) throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of 10+ characters in .env');
  if (!(await Admin.exists({ email }))) {
    await Admin.create({ email, name: 'Admin', passwordHash: await bcrypt.hash(password, 12) });
    console.log('Admin created:', email);
  } else console.log('Admin already exists:', email);
  await require('./services/subscriptions').ensurePlans();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
