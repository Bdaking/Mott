const mongoose = require('mongoose');
const config = require('./config');
const { HttpError } = require('./utils/errors');

mongoose.set('strictQuery', true);
mongoose.set('bufferCommands', false); // when the DB is unreachable, fail fast (503) instead of hanging 10 s and returning a vague 500

let connecting = null;
let indexesDone = false;

async function syncIndexes() {
  if (indexesDone) return;
  const { User, Session } = require('./models');
  for (const M of [User, Session]) {
    try { await M.syncIndexes(); } catch (err) { console.error(`WARNING: could not create indexes for ${M.modelName}: ${err.message}`); }
  }
  indexesDone = true;
}

// Cached connection: works for `npm run dev` AND for serverless (Vercel), where the process is reused between requests.
function connect() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose);
  if (!connecting) {
    connecting = mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      family: 4, // Windows + some Wi-Fi/ISP setups resolve IPv6 first and time out; force IPv4
    }).then(async () => { console.log('MongoDB connected'); await syncIndexes(); return mongoose; })
      .catch((err) => { connecting = null; throw err; });
  }
  return connecting;
}

mongoose.connection.on('disconnected', () => { connecting = null; console.warn('MongoDB disconnected - will reconnect on the next request'); });

// Express middleware: make sure we are connected before any route touches the database.
async function ensureDb(req, res, next) {
  try { await connect(); next(); }
  catch (err) {
    console.error('Database unavailable:', err.message);
    next(new HttpError(503, 'The server cannot reach its database right now. Please try again in a moment.', 'DB_UNAVAILABLE'));
  }
}

module.exports = connect;
module.exports.connect = connect;
module.exports.ensureDb = ensureDb;
