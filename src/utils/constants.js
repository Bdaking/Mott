// The HLS ladder. Heights are the "quality" numbers used everywhere (plans, player).
const QUALITIES = [360, 480, 720, 1080];
const FREE_MAX_QUALITY = 360; // what a signed-in user without a plan gets on movies marked "Free"

// Default plans (created automatically the first time the server starts; editable later in Admin > Plans).
const DEFAULT_PLANS = [
  {
    key: 'basic', name: 'Basic', rank: 1, maxQuality: 480, qualityLabel: '360p - 480p', price: 149, durationDays: 3, sortOrder: 1,
    features: ['Standard video quality (360p - 480p)', 'Watch included movies', 'One device at a time'],
  },
  {
    key: 'standard', name: 'Standard', rank: 2, maxQuality: 720, qualityLabel: 'HD up to 720p', price: 299, durationDays: 5, sortOrder: 2,
    features: ['HD quality up to 720p', 'Watch included movies', 'One device at a time'],
  },
  {
    key: 'premium', name: 'Premium', rank: 3, maxQuality: 1080, qualityLabel: 'Full HD up to 1080p', price: 499, durationDays: 7, sortOrder: 3,
    features: ['Full HD quality up to 1080p', 'Watch included movies', 'One device at a time'],
  },
];

// Movie "included in" levels: 0 = free for every signed-in user, 1..3 = needs that plan rank or higher.
const MOVIE_LEVELS = { 0: 'Free (no plan needed)', 1: 'Basic and above', 2: 'Standard and above', 3: 'Premium only' };

module.exports = { QUALITIES, FREE_MAX_QUALITY, DEFAULT_PLANS, MOVIE_LEVELS };
