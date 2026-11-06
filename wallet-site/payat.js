'use strict';
/**
 * Pay@ (payat.io / payat.co.za) adapter.
 *
 * How Pay@'s "Online API" integration works (from their public site): Pay@ sends
 * real-time VALIDATION requests and PAYMENT NOTIFICATIONS to an endpoint that the
 * business provides. The customer pays with a reference (account) number at a Pay@
 * retail partner, bank, mobile network operator, or the Pay@ payment portal.
 *
 * The exact payload layout, field names and authentication scheme are given to you
 * in your Pay@ merchant onboarding pack, which is not public. Everything that
 * depends on that spec is isolated in this file so it is a 5-minute change:
 *
 *   - authorised()   -> how Pay@ proves a request really came from them
 *   - parseValidate()/parseNotify() -> which fields hold account, amount, txn id
 *   - the response bodies returned by the two routes in server.js
 *
 * Until you have the spec, the parsers accept the common field-name spellings.
 */
const crypto = require('node:crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest();

/** Constant-time string comparison. */
function safeEq(a, b) {
  return crypto.timingSafeEqual(sha(String(a)), sha(String(b)));
}

/** Optional allow-list of Pay@ server IPs (PAYAT_ALLOWED_IPS="1.2.3.4,5.6.7.8"). */
function ipAllowed(ip) {
  const list = (process.env.PAYAT_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(ip);
}

/**
 * A request is accepted if it carries the shared secret (Authorization: Bearer <secret>
 * or X-Payat-Secret) OR an HMAC-SHA256 hex signature of the raw body made with the
 * secret (X-Signature / X-Payat-Signature). Without PAYAT_SECRET set, nothing is accepted.
 */
function authorised(req, raw, ip) {
  const secret = process.env.PAYAT_SECRET || '';
  if (!secret || !ipAllowed(ip)) return false;

  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const header = req.headers['x-payat-secret'] || bearer;
  if (header && safeEq(header, secret)) return true;

  const sig = req.headers['x-signature'] || req.headers['x-payat-signature'];
  if (sig) {
    const mac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return safeEq(String(sig).replace(/^sha256=/i, '').toLowerCase(), mac);
  }
  return false;
}

/** Case-insensitive lookup of the first present key from `names`. */
function pick(obj, names) {
  const flat = { ...(obj && typeof obj.data === 'object' && obj.data ? obj.data : {}), ...(obj || {}) };
  const lower = {};
  for (const [k, v] of Object.entries(flat)) lower[k.toLowerCase()] = v;
  for (const n of names) {
    const v = lower[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Convert an amount from the payload to integer cents. Rands by default. */
function toCents(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  const n = parseFloat(s.replace(/[^\d.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return process.env.PAYAT_AMOUNT_IN_CENTS === '1' ? Math.round(n) : Math.round(n * 100);
}

const cleanAccount = (v) => (v === null ? null : String(v).replace(/[\s\-]/g, ''));

const ACCOUNT_FIELDS = ['account', 'accountnumber', 'account_number', 'accountno', 'reference',
  'referencenumber', 'reference_number', 'ref', 'customerreference', 'customer_reference'];
const TXN_FIELDS = ['transactionid', 'transaction_id', 'paymentid', 'payment_id', 'txid', 'receipt',
  'receiptnumber', 'receipt_number', 'payatreference', 'id'];
const AMOUNT_FIELDS = ['amount', 'amountpaid', 'amount_paid', 'paymentamount', 'payment_amount', 'value'];

function parseValidate(body) {
  return { account: cleanAccount(pick(body, ACCOUNT_FIELDS)) };
}

function parseNotify(body) {
  const t = pick(body, TXN_FIELDS);
  return {
    account: cleanAccount(pick(body, ACCOUNT_FIELDS)),
    amountCents: toCents(pick(body, AMOUNT_FIELDS)),
    transactionId: t === null ? null : String(t).trim().slice(0, 100),
  };
}

module.exports = { authorised, parseValidate, parseNotify, safeEq };
