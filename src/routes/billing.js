// Plans, checkout (dummy gateway), subscription status.
//   GET  /api/plans                  public: the plans on sale
//   GET  /api/billing/subscription   my current plan (or null)
//   POST /api/billing/checkout       { planKey }              -> creates a pending payment
//   POST /api/billing/pay            { paymentId, card }      -> dummy gateway charge -> activates the plan
//   POST /api/billing/cancel | /resume                         stop / restart auto-renew (access stays until the end date)
//   GET  /api/billing/history        my payments
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const { Plan, Subscription, Payment } = require('../models');
const { requireUser } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { asyncHandler, HttpError } = require('../utils/errors');
const subs = require('../services/subscriptions');
const gateway = require('../services/dummyGateway');

const isId = (id) => /^[a-f\d]{24}$/i.test(id);
const payDto = (p) => ({
  id: String(p._id), planKey: p.planKey, planName: p.planName, amount: p.amount, currency: p.currency, status: p.status,
  method: p.method, brand: p.brand || null, last4: p.last4 || null, reference: p.reference || null,
  failureReason: p.failureReason || null, createdAt: p.createdAt, paidAt: p.paidAt || null,
});
const needPayments = (req, res, next) => (config.payments.enabled ? next() : next(new HttpError(503, 'Payments are switched off on this server.', 'PAYMENTS_OFF')));

router.get('/plans', asyncHandler(async (req, res) => {
  const plans = await Plan.find({ active: true }).sort({ rank: 1 });
  res.json({
    plans: plans.map(subs.planDto),
    payments: { enabled: config.payments.enabled, mode: config.payments.mode },
    // Shown in the app so testers know which cards work.
    testCards: config.payments.enabled ? gateway.TEST_CARDS.map((c) => ({ number: c.number, brand: c.brand, result: c.note })) : [],
  });
}));

router.use('/billing', requireUser);

router.get('/billing/subscription', asyncHandler(async (req, res) => {
  res.json({ subscription: subs.subDto(await subs.getActive(req.user._id)) });
}));

router.get('/billing/history', asyncHandler(async (req, res) => {
  const rows = await Payment.find({ user: req.user._id, status: { $in: ['succeeded', 'failed'] } }).sort({ createdAt: -1 }).limit(30);
  res.json(rows.map(payDto));
}));

router.post('/billing/checkout', needPayments, rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, keyGenerator: (req) => String(req.user._id) }),
  validate(z.object({ planKey: z.string().min(2).max(30) })), asyncHandler(async (req, res) => {
    const plan = await Plan.findOne({ key: req.body.planKey.toLowerCase(), active: true });
    if (!plan) throw new HttpError(404, 'That plan is not available.', 'PLAN_NOT_FOUND');
    const pay = await Payment.create({ user: req.user._id, plan: plan._id, planKey: plan.key, planName: plan.name, amount: plan.price, currency: plan.currency });
    res.status(201).json({ paymentId: String(pay._id), plan: subs.planDto(plan), amount: plan.price, currency: plan.currency });
  }));

const cardSchema = z.object({
  paymentId: z.string().regex(/^[a-f\d]{24}$/i),
  card: z.object({
    number: z.string().min(8).max(25),
    expiry: z.string().min(1).max(7),
    cvv: z.string().max(6),
    name: z.string().trim().max(60).optional(),
  }),
});

router.post('/billing/pay', needPayments, rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, keyGenerator: (req) => String(req.user._id) }),
  validate(cardSchema), asyncHandler(async (req, res) => {
    const { paymentId, card } = req.body;
    const done = async (pay) => res.json({ payment: payDto(pay), subscription: subs.subDto(await subs.getActive(req.user._id)) });

    // Claim the payment atomically so a double tap (or two devices) can never charge/activate twice.
    const stale = new Date(Date.now() - 2 * 60 * 1000);
    const pay = await Payment.findOneAndUpdate(
      { _id: paymentId, user: req.user._id, $or: [{ status: { $in: ['created', 'failed'] } }, { status: 'processing', updatedAt: { $lt: stale } }] },
      { status: 'processing', $inc: { attempts: 1 } }, { new: true });
    if (!pay) {
      const existing = isId(paymentId) ? await Payment.findOne({ _id: paymentId, user: req.user._id }) : null;
      if (!existing) throw new HttpError(404, 'Payment not found. Start again from the plan screen.', 'PAYMENT_NOT_FOUND');
      if (existing.status === 'succeeded') return done(existing); // idempotent: already paid
      throw new HttpError(409, 'This payment is already being processed.', 'PAYMENT_BUSY');
    }

    let result;
    try { result = await gateway.charge({ ...card, amount: pay.amount }); }
    catch (err) { result = { ok: false, code: 'gateway_error', message: 'The payment service had a problem. You were not charged. Try again.' }; console.error('Dummy gateway error:', err.message); }

    if (!result.ok) {
      pay.status = 'failed'; pay.failureCode = result.code; pay.failureReason = result.message;
      if (result.last4) { pay.last4 = result.last4; pay.brand = result.brand; }
      await pay.save();
      throw new HttpError(402, result.message, 'PAYMENT_FAILED');
    }

    const plan = await Plan.findById(pay.plan);
    if (!plan) { pay.status = 'failed'; pay.failureReason = 'Plan no longer exists'; await pay.save(); throw new HttpError(409, 'That plan is no longer available. You were not charged.', 'PLAN_NOT_FOUND'); }
    Object.assign(pay, { status: 'succeeded', brand: result.brand, last4: result.last4, reference: result.reference, paidAt: new Date(), failureCode: undefined, failureReason: undefined });
    await pay.save();
    await subs.activate(req.user._id, plan, { paymentId: pay._id, source: 'payment' });
    await done(pay);
  }));

router.post('/billing/cancel', asyncHandler(async (req, res) => {
  const sub = await subs.getActive(req.user._id);
  if (!sub) throw new HttpError(400, 'You do not have an active plan.', 'NO_PLAN');
  await Subscription.updateOne({ _id: sub._id }, { status: 'cancelled', cancelledAt: new Date() });
  res.json({ subscription: subs.subDto(await subs.getActive(req.user._id)) });
}));

router.post('/billing/resume', asyncHandler(async (req, res) => {
  const sub = await subs.getActive(req.user._id);
  if (!sub) throw new HttpError(400, 'Your plan has already ended. Choose a plan again.', 'NO_PLAN');
  await Subscription.updateOne({ _id: sub._id }, { status: 'active', $unset: { cancelledAt: 1 } });
  res.json({ subscription: subs.subDto(await subs.getActive(req.user._id)) });
}));

module.exports = router;
module.exports.payDto = payDto;
