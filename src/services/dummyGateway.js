// A FAKE payment gateway for development and demos. No money moves and nothing is sent anywhere.
//
// Safety rules:
//  * Only the documented TEST card numbers below are accepted. Anything else is refused with a hint, so nobody types a real card here.
//  * The card number and CVV are validated in memory and thrown away. Only brand + last 4 digits are ever returned/stored.
const crypto = require('crypto');
const config = require('../config');

const TEST_CARDS = [
  { number: '4242424242424242', brand: 'Visa', result: 'success', note: 'Payment succeeds' },
  { number: '5555555555554444', brand: 'Mastercard', result: 'success', note: 'Payment succeeds' },
  { number: '378282246310005', brand: 'Amex', result: 'success', note: 'Payment succeeds' },
  { number: '4000000000000002', brand: 'Visa', result: 'declined', note: 'Card declined' },
  { number: '4000000000009995', brand: 'Visa', result: 'insufficient_funds', note: 'Insufficient funds' },
  { number: '4000000000000069', brand: 'Visa', result: 'expired_card', note: 'Expired card' },
];
const FAILURES = {
  declined: 'Your card was declined. Try another card.',
  insufficient_funds: 'Your card has insufficient funds.',
  expired_card: 'Your card has expired.',
  bad_cvc: 'The security code (CVV) is not correct.',
  bad_expiry: 'The expiry date is not valid or the card has expired.',
  not_test_card: 'This is a demo payment screen. Use a test card such as 4242 4242 4242 4242 (any future expiry, any 3-digit CVV).',
};

const digits = (s) => String(s || '').replace(/\D/g, '');
function luhn(num) {
  let sum = 0; let alt = false;
  for (let i = num.length - 1; i >= 0; i--) { let n = Number(num[i]); if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return num.length >= 12 && sum % 10 === 0;
}
const brandOf = (n) => (/^4/.test(n) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : 'Card');

// "MM/YY" or "MMYY" -> true when the month is valid and the card is not expired (valid through the END of that month).
function expiryOk(raw, now = new Date()) {
  const d = digits(raw);
  if (d.length !== 4) return false;
  const mm = Number(d.slice(0, 2)); const yy = 2000 + Number(d.slice(2));
  if (mm < 1 || mm > 12) return false;
  return yy > now.getFullYear() || (yy === now.getFullYear() && mm >= now.getMonth() + 1);
}

// Returns { ok:true, brand, last4, reference } or { ok:false, code, message, brand?, last4? }. Never throws for card problems.
async function charge({ number, expiry, cvv, amount }) {
  if (config.payments.latencyMs) await new Promise((r) => setTimeout(r, config.payments.latencyMs)); // feels like a real gateway
  const n = digits(number);
  const last4 = n.slice(-4);
  const brand = brandOf(n);
  const fail = (code) => ({ ok: false, code, message: FAILURES[code], brand, last4 });

  if (!luhn(n)) return { ok: false, code: 'invalid_number', message: 'That card number is not valid. Check it and try again.' };
  const test = TEST_CARDS.find((c) => c.number === n);
  if (!test) return fail('not_test_card');
  if (!expiryOk(expiry)) return fail('bad_expiry');
  const c = digits(cvv);
  if (c.length !== (brand === 'Amex' ? 4 : 3)) return fail('bad_cvc');
  if (test.result !== 'success') return fail(test.result);
  if (!(amount >= 0)) return { ok: false, code: 'bad_amount', message: 'Invalid amount.' };
  return { ok: true, brand, last4, reference: `dummy_${crypto.randomBytes(8).toString('hex')}` };
}

module.exports = { charge, luhn, expiryOk, brandOf, TEST_CARDS, digits };
