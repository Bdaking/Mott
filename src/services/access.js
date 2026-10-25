// The one place that decides "may this user watch this movie, and at what quality?".
//
//   movie.minPlanRank 0     -> free for every signed-in user (360p unless they have a plan, then their plan's quality)
//   movie.minPlanRank 1..3  -> needs an ACTIVE subscription whose plan rank is >= that number
//
// Returned object: { allowed, reason?, requiredRank, maxQuality, planKey?, planName? }
//   reason: SUBSCRIPTION_REQUIRED (no valid plan)  |  UPGRADE_REQUIRED (plan too low for this movie)
const { getActive } = require('./subscriptions');
const { Plan } = require('../models');
const { FREE_MAX_QUALITY } = require('../utils/constants');

async function resolveAccess(userId, movie) {
  const requiredRank = movie.minPlanRank ?? 1;
  const sub = await getActive(userId);
  const plan = sub?.plan;
  const base = { requiredRank, planKey: plan?.key || null, planName: plan?.name || null };

  if (requiredRank === 0) return { ...base, allowed: true, via: 'free', maxQuality: plan ? plan.maxQuality : FREE_MAX_QUALITY };
  if (!plan) return { ...base, allowed: false, reason: 'SUBSCRIPTION_REQUIRED', maxQuality: 0 };
  if (plan.rank < requiredRank) return { ...base, allowed: false, reason: 'UPGRADE_REQUIRED', maxQuality: plan.maxQuality };
  return { ...base, allowed: true, via: 'plan', maxQuality: plan.maxQuality };
}

async function denyMessage(access) {
  if (access.reason === 'UPGRADE_REQUIRED') {
    const need = await Plan.findOne({ rank: { $gte: access.requiredRank } }).sort({ rank: 1 });
    return `This movie is included in the ${need ? need.name : 'higher'} plan and above. Upgrade your plan to watch it.`;
  }
  return 'Choose a plan to watch this movie.';
}

const qualityText = (q) => (q >= 1080 ? 'Full HD 1080p' : q >= 720 ? 'HD 720p' : `${q}p`);

module.exports = { resolveAccess, denyMessage, qualityText };
