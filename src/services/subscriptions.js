// Plans + the user's current subscription. One place that answers "which plan does this user have right now?".
const { Plan, Subscription } = require('../models');
const { DEFAULT_PLANS } = require('../utils/constants');

const DAY = 86400000;

// First start: create Basic / Standard / Premium. Never overwrites what the admin edited later.
async function ensurePlans() {
  if ((await Plan.estimatedDocumentCount()) > 0) return;
  await Plan.insertMany(DEFAULT_PLANS);
  console.log('Default plans created: Basic, Standard, Premium (edit them in Admin > Plans)');
}

const planDto = (p) => ({
  id: String(p._id), key: p.key, name: p.name, rank: p.rank, maxQuality: p.maxQuality, qualityLabel: p.qualityLabel,
  price: p.price, currency: p.currency, durationDays: p.durationDays, features: p.features || [], active: p.active,
});

// The user's valid subscription (status active, or cancelled but not yet expired) with its plan, or null.
async function getActive(userId) {
  const sub = await Subscription.findOne({ user: userId, expiresAt: { $gt: new Date() } }).populate('plan');
  if (!sub || !sub.plan) return null;
  return sub;
}

const subDto = (sub) => (sub ? {
  plan: planDto(sub.plan),
  status: sub.status, // active | cancelled (cancelled = ends on expiresAt, no renewal)
  startedAt: sub.startedAt,
  expiresAt: sub.expiresAt,
  daysLeft: Math.max(0, Math.ceil((sub.expiresAt.getTime() - Date.now()) / DAY)),
  source: sub.source,
} : null);

// Buying the SAME plan again extends it; buying a DIFFERENT plan switches immediately (dummy build: no proration).
async function activate(userId, plan, { paymentId = null, source = 'payment' } = {}) {
  const now = new Date();
  const existing = await Subscription.findOne({ user: userId });
  const sameAndValid = existing && String(existing.plan) === String(plan._id) && existing.expiresAt > now && existing.status === 'active';
  const base = sameAndValid ? existing.expiresAt.getTime() : now.getTime();
  return Subscription.findOneAndUpdate(
    { user: userId },
    { user: userId, plan: plan._id, status: 'active', startedAt: sameAndValid ? existing.startedAt : now, expiresAt: new Date(base + plan.durationDays * DAY), $unset: { cancelledAt: 1 }, source, lastPayment: paymentId },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).populate('plan');
}

const end = (userId) => Subscription.updateOne({ user: userId }, { expiresAt: new Date() }); // immediate end (admin)

module.exports = { ensurePlans, planDto, getActive, subDto, activate, end };
