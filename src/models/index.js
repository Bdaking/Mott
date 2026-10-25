const mongoose = require('mongoose');
const { Schema } = mongoose;
const oid = (ref, required = true) => ({ type: Schema.Types.ObjectId, ref, required });

// Users sign in with a one-time code sent to an email or a phone number (no password).
const User = mongoose.model('User', new Schema({
  name: { type: String, default: '', trim: true },
  email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  phone: { type: String, trim: true, unique: true, sparse: true }, // E.164, e.g. +919876543210
  passwordHash: String, // legacy (old email+password accounts); no longer used to sign in
  isActive: { type: Boolean, default: true },
}, { timestamps: true }));

const Admin = mongoose.model('Admin', new Schema({
  name: { type: String, default: 'Admin' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
}, { timestamps: true }));

const otpSchema = new Schema({
  identifier: { type: String, required: true, index: true }, // normalised email or E.164 phone
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  sentAt: { type: Date, default: Date.now },
});
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // kept 1h after expiry so the hourly send cap works
const OtpCode = mongoose.model('OtpCode', otpSchema);

// A login on one device. `active` is true for at most ONE session per user (unique partial index = enforced by MongoDB itself).
const sessionSchema = new Schema({
  user: oid('User'),
  deviceId: { type: String, required: true },
  deviceName: { type: String, default: 'Unknown device' },
  platform: { type: String, default: '' },
  refreshHash: { type: String, required: true },
  active: { type: Boolean, default: true },
  revokedReason: String, // logout | replaced | admin | refresh_reuse | blocked | expired
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  ip: String,
  playing: {
    movie: { type: Schema.Types.ObjectId, ref: 'Movie' },
    jti: String,
    startedAt: Date,
    lastBeatAt: Date,
    claimedBy: String, // hash of the user-agent that opened the player page
  },
}, { timestamps: true });
sessionSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { active: true } });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
const Session = mongoose.model('Session', sessionSchema);

const imageRef = { _id: false, publicId: String, url: String };
const Movie = mongoose.model('Movie', new Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  year: Number,
  durationMin: Number,
  genres: [String],
  language: { type: String, default: '' },
  certificate: { type: String, default: '' },
  director: { type: String, default: '' },
  cast: [String],
  poster: imageRef,   // Cloudinary
  backdrop: imageRef, // Cloudinary
  trailer: { _id: false, publicId: String, url: String }, // Cloudinary (video)
  // Which plans include this movie: 0 = free for every signed-in user, 1 = Basic and above (default), 2 = Standard and above, 3 = Premium only.
  minPlanRank: { type: Number, enum: [0, 1, 2, 3], default: 1 },
  featured: { type: Boolean, default: false },
  published: { type: Boolean, default: false },
  vimeo: {                                            // the movie itself lives on Vimeo; only ids are stored here
    _id: false,
    videoId: String,
    hash: String,       // privacy hash of unlisted videos
    uri: String,
    link: String,
  },
  processing: {
    status: { type: String, enum: ['none', 'uploading', 'processing', 'completed', 'failed'], default: 'none' },
    percent: { type: Number, default: 0 },
    error: String,
  },
}, { timestamps: true }));

const histSchema = new Schema({
  user: oid('User'),
  movie: oid('Movie'),
  positionSec: { type: Number, default: 0 },
  durationSec: { type: Number, default: 0 },
  completed: { type: Boolean, default: false },
}, { timestamps: true });
histSchema.index({ user: 1, movie: 1 }, { unique: true });
const WatchHistory = mongoose.model('WatchHistory', histSchema);

const wlSchema = new Schema({ user: oid('User'), movie: oid('Movie') }, { timestamps: true });
wlSchema.index({ user: 1, movie: 1 }, { unique: true });
const Watchlist = mongoose.model('Watchlist', wlSchema);

// ---------- plans, subscriptions, payments ----------
const Plan = mongoose.model('Plan', new Schema({
  key: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  rank: { type: Number, required: true, min: 1 },           // higher = better plan
  maxQuality: { type: Number, required: true, enum: [360, 480, 720, 1080] }, // highest video height this plan may stream
  qualityLabel: { type: String, default: '' },
  price: { type: Number, required: true, min: 0 },          // in rupees
  currency: { type: String, default: 'INR' },
  durationDays: { type: Number, default: 30, min: 1 },
  features: [String],
  active: { type: Boolean, default: true },                 // inactive plans cannot be bought; existing subscribers keep them until expiry
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true }));

// One document per user (their CURRENT plan). The history of what they paid is in Payment.
const Subscription = mongoose.model('Subscription', new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  plan: oid('Plan'),
  status: { type: String, enum: ['active', 'cancelled'], default: 'active' }, // cancelled = will not renew, still valid until expiresAt
  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  cancelledAt: Date,
  source: { type: String, enum: ['payment', 'admin'], default: 'payment' },
  lastPayment: { type: Schema.Types.ObjectId, ref: 'Payment' },
}, { timestamps: true }));

// Dummy-gateway payments. Card numbers and CVV are NEVER stored: only brand + last 4 digits.
const Payment = mongoose.model('Payment', new Schema({
  user: oid('User'),
  plan: oid('Plan'),
  planKey: String,
  planName: String,
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['created', 'processing', 'succeeded', 'failed'], default: 'created', index: true },
  method: { type: String, default: 'dummy_card' },          // dummy_card | admin_grant
  brand: String,
  last4: String,
  reference: String,                                          // dummy gateway transaction id
  failureCode: String,
  failureReason: String,
  attempts: { type: Number, default: 0 },
  paidAt: Date,
}, { timestamps: true }));

module.exports = { User, Admin, OtpCode, Session, Movie, WatchHistory, Watchlist, Plan, Subscription, Payment };
