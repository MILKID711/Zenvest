'use strict';
/**
 * Wallet website: email / phone login, a wallet balance, and top-ups by voucher or Pay@.
 * Zero npm dependencies: Node 22.13+ (built-in SQLite, crypto, http).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file, fine */ }

const { DatabaseSync } = require('node:sqlite');
const payat = require('./payat');
const scrypt = promisify(crypto.scrypt);

// ───────────────────────────── config ─────────────────────────────
const CFG = {
  port: process.env.PORT !== undefined ? Number(process.env.PORT) : 3000,
  dbPath: process.env.DB_PATH || path.join(__dirname, 'data', 'wallet.db'),
  appName: process.env.APP_NAME || 'Wallet',
  currency: process.env.CURRENCY_SYMBOL || 'R',
  countryCode: (process.env.DEFAULT_COUNTRY_CODE || '27').replace(/\D/g, ''),
  adminKey: (process.env.ADMIN_KEY || '').length >= 16 ? process.env.ADMIN_KEY : '',
  demo: process.env.DEMO_MODE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
  cookieSecure: process.env.COOKIE_SECURE === '1',
  portalUrl: process.env.PAYAT_PORTAL_URL || '',
  authLimit: Number(process.env.AUTH_RATE_LIMIT || 20), // auth requests / minute / IP
};
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_TOPUP_CENTS = 100_000_000; // R1,000,000 per Pay@ payment
const MAX_VOUCHER_CENTS = 10_000_000; // R100,000 per voucher

// ───────────────────────────── database ─────────────────────────────
fs.mkdirSync(path.dirname(CFG.dbPath), { recursive: true });
const db = new DatabaseSync(CFG.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  pass TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  reference TEXT NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref TEXT,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (type, ref)
);
CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id, id DESC);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  hint TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  batch TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  redeemed_by INTEGER REFERENCES users(id),
  redeemed_at TEXT,
  voided_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  body TEXT
);
`);

const WALLET_SELECT = `SELECT w.user_id, w.reference, w.balance, u.email, u.phone
  FROM wallets w JOIN users u ON u.id = w.user_id`;
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userByPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  insertUser: db.prepare('INSERT INTO users (email, phone, pass, created_at) VALUES (?, ?, ?, ?)'),
  insertWallet: db.prepare('INSERT INTO wallets (user_id, reference) VALUES (?, ?)'),
  refExists: db.prepare('SELECT 1 FROM wallets WHERE reference = ?'),
  walletByUser: db.prepare(`${WALLET_SELECT} WHERE w.user_id = ?`),
  walletByRef: db.prepare(`${WALLET_SELECT} WHERE w.reference = ?`),
  walletByPhone: db.prepare(`${WALLET_SELECT} WHERE u.phone = ?`),
  addBalance: db.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?'),
  txnByRef: db.prepare('SELECT id FROM transactions WHERE type = ? AND ref = ?'),
  insertTxn: db.prepare(`INSERT INTO transactions (user_id, type, amount, balance_after, ref, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  txnList: db.prepare(`SELECT id, type, amount, balance_after, description, created_at
    FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50`),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionByHash: db.prepare(`SELECT s.user_id, u.email, u.phone FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  voucherByHash: db.prepare('SELECT * FROM vouchers WHERE code_hash = ?'),
  insertVoucher: db.prepare(`INSERT INTO vouchers (code_hash, hint, amount, batch, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  markRedeemed: db.prepare(`UPDATE vouchers SET redeemed_by = ?, redeemed_at = ?
    WHERE id = ? AND redeemed_by IS NULL AND voided_at IS NULL`),
  voidVoucher: db.prepare(`UPDATE vouchers SET voided_at = ?
    WHERE id = ? AND redeemed_by IS NULL AND voided_at IS NULL`),
  voucherList: db.prepare(`SELECT id, hint, amount, batch, note, created_at, redeemed_at, voided_at
    FROM vouchers ORDER BY id DESC LIMIT ?`),
  logEvent: db.prepare('INSERT INTO payat_events (received_at, kind, outcome, body) VALUES (?, ?, ?, ?)'),
};

/** Run fn inside an immediate (write-locked) transaction. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

// ───────────────────────────── helpers ─────────────────────────────
const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

function clientIp(req) {
  if (CFG.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { failed = true; reject(httpError(413, 'Request too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

/** Browser-facing routes must be JSON (blocks cross-site form posts). Pay@ routes are lenient. */
function parseBody(raw, contentType, lenient = false) {
  if (!raw.length) return {};
  const ct = String(contentType || '').toLowerCase();
  const text = raw.toString('utf8');
  try {
    if (ct.includes('application/json')) return JSON.parse(text);
    if (lenient && ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    if (lenient) return JSON.parse(text);
  } catch {
    throw httpError(400, 'Could not read the request body.');
  }
  throw httpError(415, 'Content-Type must be application/json');
}

// simple in-memory sliding-window rate limiter
const hits = new Map();
const rl = {
  hit(key) { const a = hits.get(key) || []; a.push(Date.now()); hits.set(key, a); },
  count(key, windowMs) {
    const cutoff = Date.now() - windowMs;
    const a = (hits.get(key) || []).filter((t) => t > cutoff);
    hits.set(key, a);
    return a.length;
  },
  clear(key) { hits.delete(key); },
};

// ───────────────────────────── identity ─────────────────────────────
/** Accepts an email or a phone number; returns { kind, value } or null. */
function normalizeIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 254) return null;
  if (s.includes('@')) {
    const email = s.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? { kind: 'email', value: email } : null;
  }
  let d = s.replace(/[\s\-().]/g, '');
  const hasPlus = d.startsWith('+');
  d = d.replace(/^\+/, '');
  if (!/^\d+$/.test(d)) return null;
  if (!hasPlus) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = CFG.countryCode + d.slice(1);
  }
  return /^\d{8,15}$/.test(d) ? { kind: 'phone', value: '+' + d } : null;
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing'); // promise, resolved lazily

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ } }
  }
  return out;
}

function cookieFlags(req) {
  const secure = CFG.cookieSecure || (CFG.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  return `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function startSession(req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_MS);
  return { 'Set-Cookie': `sid=${token}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags(req)}` };
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie).sid;
  return token ? q.sessionByHash.get(sha256(token), Date.now()) || null : null;
}

// ───────────────────────────── wallet ─────────────────────────────
function newReference() {
  for (let i = 0; i < 25; i++) {
    const ref = String(crypto.randomInt(1_000_000_000, 10_000_000_000));
    if (!q.refExists.get(ref)) return ref;
  }
  throw new Error('Could not allocate a wallet reference');
}

/** Must run inside tx(). Idempotent when `ref` is given: the same (type, ref) is never credited twice. */
function credit(userId, type, amountCents, ref, description) {
  if (ref && q.txnByRef.get(type, ref)) return { duplicate: true };
  q.addBalance.run(amountCents, userId);
  const wallet = q.walletByUser.get(userId);
  q.insertTxn.run(userId, type, amountCents, wallet.balance, ref || null, description, now());
  return { duplicate: false, balance: wallet.balance };
}

function findWalletByAccount(account) {
  if (!account) return null;
  const byRef = q.walletByRef.get(account);
  if (byRef) return byRef;
  const id = normalizeIdentifier(account);
  return id && id.kind === 'phone' ? q.walletByPhone.get(id.value) || null : null;
}

const maskAccount = (w) => (w.email
  ? `${w.email.split('@')[0][0]}***@${w.email.split('@')[1]}`
  : `${w.phone.slice(0, 3)}****${w.phone.slice(-3)}`);

// ───────────────────────────── vouchers ─────────────────────────────
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const formatCode = (code) => code.match(/.{4}/g).join('-');

function generateCode() {
  let code = '';
  for (let i = 0; i < 16; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function createVouchers(amountCents, count, note) {
  const batch = crypto.randomBytes(3).toString('hex');
  const codes = [];
  tx(() => {
    for (let i = 0; i < count; i++) {
      let code;
      do { code = generateCode(); } while (q.voucherByHash.get(sha256(code)));
      q.insertVoucher.run(sha256(code), code.slice(-4), amountCents, batch, note || null, now());
      codes.push(formatCode(code));
    }
  });
  return { batch, codes };
}

const BAD_VOUCHER = 'That voucher code is not valid, or it has already been used.';

function redeemVoucher(userId, rawCode) {
  const code = normalizeCode(rawCode);
  if (code.length !== 16) return { ok: false, error: BAD_VOUCHER };
  return tx(() => {
    const v = q.voucherByHash.get(sha256(code));
    if (!v || v.voided_at || v.redeemed_by) return { ok: false, error: BAD_VOUCHER };
    if (q.markRedeemed.run(userId, now(), v.id).changes !== 1) return { ok: false, error: BAD_VOUCHER };
    const c = credit(userId, 'voucher', v.amount, `voucher:${v.id}`, `Voucher ending ${v.hint}`);
    return { ok: true, amount: v.amount, balance: c.balance };
  });
}

// ───────────────────────────── routes ─────────────────────────────
function requireSession(req, res) {
  const s = getSession(req);
  if (!s) send(res, 401, { error: 'Please sign in.' });
  return s;
}

function adminOk(req, res, ip) {
  if (!CFG.adminKey) { send(res, 503, { error: 'Admin is disabled. Set ADMIN_KEY (16+ characters).' }); return false; }
  if (rl.count(`admin:${ip}`, 60_000) >= 20) { send(res, 429, { error: 'Too many attempts.' }); return false; }
  const key = req.headers['x-admin-key'];
  if (!key || !payat.safeEq(key, CFG.adminKey)) {
    rl.hit(`admin:${ip}`);
    send(res, 401, { error: 'Wrong admin key.' });
    return false;
  }
  return true;
}

function walletPayload(s) {
  const w = q.walletByUser.get(s.user_id);
  return {
    identifier: s.email || s.phone,
    kind: s.email ? 'email' : 'phone',
    balance: w.balance,
    reference: w.reference,
  };
}

async function handleApi(req, res, p, url, ip) {
  const route = `${req.method} ${p}`;
  const isPost = req.method === 'POST';
  const raw = isPost ? await readBody(req) : Buffer.alloc(0);
  const jsonBody = () => parseBody(raw, req.headers['content-type']);

  switch (route) {
    case 'GET /api/config':
      return send(res, 200, {
        appName: CFG.appName, currency: CFG.currency, countryCode: CFG.countryCode,
        demo: CFG.demo, payatPortalUrl: CFG.portalUrl,
        payatEnabled: Boolean(process.env.PAYAT_SECRET) || Boolean(CFG.portalUrl) || CFG.demo,
      });

    case 'POST /api/register': {
      if (rl.count(`auth:${ip}`, 60_000) >= CFG.authLimit) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      rl.hit(`auth:${ip}`);
      const body = jsonBody();
      const id = normalizeIdentifier(body.identifier);
      if (!id) return send(res, 400, { error: 'Enter a valid email address or phone number.' });
      const pw = String(body.password || '');
      if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      const pass = await hashPassword(pw);
      let userId;
      try {
        userId = tx(() => {
          const r = q.insertUser.run(id.kind === 'email' ? id.value : null, id.kind === 'phone' ? id.value : null, pass, now());
          q.insertWallet.run(r.lastInsertRowid, newReference());
          return Number(r.lastInsertRowid);
        });
      } catch (err) {
        if (/UNIQUE/.test(err.message)) {
          return send(res, 409, { error: `An account with that ${id.kind === 'email' ? 'email' : 'phone number'} already exists. Try signing in.` });
        }
        throw err;
      }
      return send(res, 201, { ok: true }, startSession(req, userId));
    }

    case 'POST /api/login': {
      if (rl.count(`auth:${ip}`, 60_000) >= CFG.authLimit) return send(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      rl.hit(`auth:${ip}`);
      const body = jsonBody();
      const id = normalizeIdentifier(body.identifier);
      const wrong = () => send(res, 401, { error: 'Wrong email/phone number or password.' });
      if (!id) return wrong();
      const failKey = `fail:${id.value}`;
      if (rl.count(failKey, 15 * 60_000) >= 8) return send(res, 429, { error: 'Too many wrong passwords. Try again in 15 minutes.' });
      const user = (id.kind === 'email' ? q.userByEmail : q.userByPhone).get(id.value);
      const ok = user
        ? await verifyPassword(String(body.password || ''), user.pass)
        : (await verifyPassword(String(body.password || ''), await DUMMY_HASH), false);
      if (!ok) { rl.hit(failKey); return wrong(); }
      rl.clear(failKey);
      return send(res, 200, { ok: true }, startSession(req, user.id));
    }

    case 'POST /api/logout': {
      const token = parseCookies(req.headers.cookie).sid;
      if (token) q.deleteSession.run(sha256(token));
      return send(res, 200, { ok: true }, { 'Set-Cookie': `sid=; Max-Age=0; ${cookieFlags(req)}` });
    }

    case 'GET /api/me': {
      const s = requireSession(req, res); if (!s) return;
      return send(res, 200, walletPayload(s));
    }

    case 'GET /api/transactions': {
      const s = requireSession(req, res); if (!s) return;
      return send(res, 200, { transactions: q.txnList.all(s.user_id) });
    }

    case 'POST /api/vouchers/redeem': {
      const s = requireSession(req, res); if (!s) return;
      const failKey = `voucher:${s.user_id}`;
      if (rl.count(failKey, 15 * 60_000) >= 5) return send(res, 429, { error: 'Too many incorrect codes. Try again in 15 minutes.' });
      const result = redeemVoucher(s.user_id, jsonBody().code);
      if (!result.ok) { rl.hit(failKey); return send(res, 400, { error: result.error }); }
      return send(res, 200, { ok: true, amount: result.amount, balance: result.balance });
    }

    // ── Pay@ calls these two endpoints (authenticated with PAYAT_SECRET) ──
    case 'POST /api/payat/validate': {
      if (!payat.authorised(req, raw, ip)) { rl.hit(`payat:${ip}`); return send(res, 401, { valid: false, message: 'Unauthorised' }); }
      const { account } = payat.parseValidate(parseBody(raw, req.headers['content-type'], true));
      const w = findWalletByAccount(account);
      q.logEvent.run(now(), 'validate', w ? 'valid' : 'unknown-account', raw.toString('utf8').slice(0, 2000));
      return w
        ? send(res, 200, { valid: true, accountName: maskAccount(w) })
        : send(res, 200, { valid: false, message: 'Account not found' });
    }

    case 'POST /api/payat/notify': {
      if (!payat.authorised(req, raw, ip)) { rl.hit(`payat:${ip}`); return send(res, 401, { success: false, message: 'Unauthorised' }); }
      const n = payat.parseNotify(parseBody(raw, req.headers['content-type'], true));
      const log = (outcome) => q.logEvent.run(now(), 'notify', outcome, raw.toString('utf8').slice(0, 2000));
      if (!n.account || !n.transactionId || n.amountCents === null || n.amountCents <= 0 || n.amountCents > MAX_TOPUP_CENTS) {
        log('rejected-bad-payload');
        return send(res, 400, { success: false, message: 'Missing or invalid account, amount or transaction id' });
      }
      const w = findWalletByAccount(n.account);
      if (!w) { log('rejected-unknown-account'); return send(res, 404, { success: false, message: 'Account not found' }); }
      const result = tx(() => credit(w.user_id, 'payat', n.amountCents, `payat:${n.transactionId}`, 'Pay@ payment'));
      log(result.duplicate ? 'duplicate-ignored' : 'credited');
      return send(res, 200, { success: true, duplicate: result.duplicate, transactionId: n.transactionId });
    }

    // ── Demo only: pretend Pay@ paid (never enable DEMO_MODE on a real site) ──
    case 'POST /api/dev/simulate-payat': {
      if (!CFG.demo) return send(res, 404, { error: 'Not found' });
      const s = requireSession(req, res); if (!s) return;
      const cents = Math.round(Number(jsonBody().amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0 || cents > 10_000_000) return send(res, 400, { error: 'Enter an amount between 1 and 100000.' });
      const r = tx(() => credit(s.user_id, 'payat', cents, `payat:demo-${crypto.randomUUID()}`, 'Pay@ payment (demo)'));
      return send(res, 200, { ok: true, balance: r.balance });
    }

    // ── Admin ──
    case 'GET /api/admin/summary': {
      if (!adminOk(req, res, ip)) return;
      const one = (sql) => db.prepare(sql).get();
      return send(res, 200, {
        users: one('SELECT COUNT(*) AS n FROM users').n,
        totalBalance: one('SELECT COALESCE(SUM(balance),0) AS n FROM wallets').n,
        outstanding: one(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS v FROM vouchers
          WHERE redeemed_by IS NULL AND voided_at IS NULL`),
        redeemed: one('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS v FROM vouchers WHERE redeemed_by IS NOT NULL'),
      });
    }

    case 'GET /api/admin/vouchers': {
      if (!adminOk(req, res, ip)) return;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
      return send(res, 200, { vouchers: q.voucherList.all(limit) });
    }

    case 'POST /api/admin/vouchers': {
      if (!adminOk(req, res, ip)) return;
      const body = jsonBody();
      const cents = Math.round(Number(body.amount) * 100);
      const count = parseInt(body.count, 10);
      if (!Number.isFinite(cents) || cents < 100 || cents > MAX_VOUCHER_CENTS) return send(res, 400, { error: 'Amount must be between 1 and 100000.' });
      if (!Number.isInteger(count) || count < 1 || count > 500) return send(res, 400, { error: 'Count must be between 1 and 500.' });
      const note = String(body.note || '').slice(0, 100);
      const { batch, codes } = createVouchers(cents, count, note);
      return send(res, 201, { batch, amount: cents, codes });
    }

    case 'POST /api/admin/vouchers/void': {
      if (!adminOk(req, res, ip)) return;
      const r = q.voidVoucher.run(now(), parseInt(jsonBody().id, 10));
      return r.changes === 1 ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Voucher not found, or already used/voided.' });
    }

    default:
      return send(res, 404, { error: 'Not found' });
  }
}

// ───────────────────────────── static files ─────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = ''; }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); res.end('Not found'); };
  if (rel.includes('\0') || !full.startsWith(PUBLIC_DIR + path.sep)) return notFound();
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return notFound();
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

// ───────────────────────────── server ─────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'Bad request' }); }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname, url, clientIp(req));
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err.status) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  }
});

setInterval(() => {
  q.purgeSessions.run(Date.now());
  for (const [k, a] of hits) if (!a.some((t) => t > Date.now() - 15 * 60_000)) hits.delete(k);
}, 10 * 60_000).unref();

server.listen(CFG.port, () => {
  console.log(`${CFG.appName} listening on http://localhost:${server.address().port}`);
  if (!process.env.PAYAT_SECRET) console.log('  note: PAYAT_SECRET not set, so the Pay@ validate/notify endpoints reject all requests.');
  if (!CFG.adminKey) console.log('  note: ADMIN_KEY (16+ chars) not set, so voucher admin is disabled.');
  if (CFG.demo) console.log('  WARNING: DEMO_MODE=1 lets any signed-in user create free balance. Never use this in production.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
