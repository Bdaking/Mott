// Vercel serverless entry: every request (/api/*, /admin/*, /health) is handled by the Express app.
module.exports = require('../src/server');
