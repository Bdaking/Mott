const { HttpError } = require('../utils/errors');
module.exports = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    const i = r.error.issues[0];
    return next(new HttpError(400, `${i.path.join('.') || 'input'}: ${i.message}`, 'VALIDATION'));
  }
  req.body = r.data;
  next();
};
