'use strict';
// End-to-end test: starts the real server on a temp database and drives it over HTTP.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 41000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = 'test-admin-key-1234567890';
const PAYAT_SECRET = 'test-payat-secret';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-test-'));

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'server.js')], {
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db'), ADMIN_KEY, PAYAT_SECRET,
    DEMO_MODE: '1', AUTH_RATE_LIMIT: '1000', PAYAT_ALLOWED_IPS: '', PAYAT_PORTAL_URL: '',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

function waitReady() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
    server.on('exit', (c) => reject(new Error('server exited early: ' + c)));
  });
}

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].startsWith('sid=') && set.includes('Max-Age=0') ? '' : set.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data, headers: res.headers };
  };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const admin = { 'X-Admin-Key': ADMIN_KEY };
const payatAuth = { 'X-Payat-Secret': PAYAT_SECRET };

(async () => {
  await waitReady();
  const anon = client();
  const phoneUser = client();
  const emailUser = client();
  let phoneRef;

  await test('config endpoint', async () => {
    const r = await anon('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.data.currency, 'R');
  });

  await test('register with a phone number (0-prefixed becomes +27)', async () => {
    const r = await phoneUser('POST', '/api/register', { identifier: '082 123 4567', password: 'correct horse' });
    assert.equal(r.status, 201);
    const me = await phoneUser('GET', '/api/me');
    assert.equal(me.data.identifier, '+27821234567');
    assert.equal(me.data.balance, 0);
    assert.match(me.data.reference, /^\d{10}$/);
    phoneRef = me.data.reference;
  });

  await test('same phone in another format is rejected as duplicate', async () => {
    const r = await anon('POST', '/api/register', { identifier: '+27 82-123-4567', password: 'whatever123' });
    assert.equal(r.status, 409);
  });

  await test('register with email, case-insensitive duplicate rejected', async () => {
    assert.equal((await emailUser('POST', '/api/register', { identifier: 'Jane@Example.com', password: 'longenough1' })).status, 201);
    assert.equal((await anon('POST', '/api/register', { identifier: 'jane@example.com', password: 'longenough1' })).status, 409);
  });

  await test('bad inputs are rejected', async () => {
    assert.equal((await anon('POST', '/api/register', { identifier: 'nope', password: 'longenough1' })).status, 400);
    assert.equal((await anon('POST', '/api/register', { identifier: 'a@b.co', password: 'short' })).status, 400);
    assert.equal((await anon('POST', '/api/register', 'identifier=a@b.co&password=longenough1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  });

  await test('login: wrong password 401, right password works, logout ends session', async () => {
    const c = client();
    assert.equal((await c('POST', '/api/login', { identifier: 'jane@example.com', password: 'wrong-password' })).status, 401);
    assert.equal((await c('POST', '/api/login', { identifier: 'nobody@example.com', password: 'wrong-password' })).status, 401);
    assert.equal((await c('GET', '/api/me')).status, 401);
    assert.equal((await c('POST', '/api/login', { identifier: 'JANE@example.com', password: 'longenough1' })).status, 200);
    assert.equal((await c('GET', '/api/me')).status, 200);
    await c('POST', '/api/logout', {});
    assert.equal((await c('GET', '/api/me')).status, 401);
  });

  await test('login by phone in any format', async () => {
    const c = client();
    assert.equal((await c('POST', '/api/login', { identifier: '+27821234567', password: 'correct horse' })).status, 200);
  });

  await test('login lockout after repeated wrong passwords', async () => {
    const c = client();
    await c('POST', '/api/register', { identifier: 'lock@example.com', password: 'longenough1' });
    const c2 = client();
    let last;
    for (let i = 0; i < 9; i++) last = await c2('POST', '/api/login', { identifier: 'lock@example.com', password: 'nope-nope-1' });
    assert.equal(last.status, 429);
    // even the right password is blocked while locked
    assert.equal((await c2('POST', '/api/login', { identifier: 'lock@example.com', password: 'longenough1' })).status, 429);
  });

  let codes;
  await test('admin: needs the key; creates vouchers', async () => {
    assert.equal((await anon('POST', '/api/admin/vouchers', { amount: 50, count: 2 })).status, 401);
    assert.equal((await anon('POST', '/api/admin/vouchers', { amount: 50, count: 2 }, { 'X-Admin-Key': 'wrong' })).status, 401);
    assert.equal((await anon('POST', '/api/admin/vouchers', { amount: 0, count: 2 }, admin)).status, 400);
    const r = await anon('POST', '/api/admin/vouchers', { amount: 50, count: 3, note: 'test batch' }, admin);
    assert.equal(r.status, 201);
    assert.equal(r.data.codes.length, 3);
    assert.match(r.data.codes[0], /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    codes = r.data.codes;
  });

  await test('voucher codes are stored hashed, never in plain text', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(dir, 'test.db'), { readOnly: true });
    const dump = JSON.stringify(d.prepare('SELECT * FROM vouchers').all());
    d.close();
    for (const c of codes) assert.ok(!dump.includes(c.replace(/-/g, '')), 'plain code found in DB');
  });

  await test('redeem voucher credits the wallet (lowercase, spaces ok)', async () => {
    const r = await phoneUser('POST', '/api/vouchers/redeem', { code: codes[0].toLowerCase().replace(/-/g, ' ') });
    assert.equal(r.status, 200);
    assert.equal(r.data.amount, 5000);
    assert.equal(r.data.balance, 5000);
  });

  await test('a used voucher cannot be redeemed again, by anyone', async () => {
    assert.equal((await phoneUser('POST', '/api/vouchers/redeem', { code: codes[0] })).status, 400);
    assert.equal((await emailUser('POST', '/api/vouchers/redeem', { code: codes[0] })).status, 400);
    assert.equal((await phoneUser('GET', '/api/me')).data.balance, 5000);
  });

  await test('parallel redemption of one voucher pays out exactly once', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => emailUser('POST', '/api/vouchers/redeem', { code: codes[1] })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal((await emailUser('GET', '/api/me')).data.balance, 5000);
  });

  await test('voided voucher cannot be redeemed', async () => {
    const list = await anon('GET', '/api/admin/vouchers', undefined, admin);
    const target = list.data.vouchers.find((v) => v.hint === codes[2].slice(-4) && !v.redeemed_at);
    assert.ok(target);
    assert.equal((await anon('POST', '/api/admin/vouchers/void', { id: target.id }, admin)).status, 200);
    assert.equal((await phoneUser('POST', '/api/vouchers/redeem', { code: codes[2] })).status, 400);
  });

  await test('voucher guessing is rate limited', async () => {
    const c = client();
    await c('POST', '/api/register', { identifier: 'guess@example.com', password: 'longenough1' });
    let last;
    for (let i = 0; i < 6; i++) last = await c('POST', '/api/vouchers/redeem', { code: 'AAAA-BBBB-CCCC-DDDD' });
    assert.equal(last.status, 429);
  });

  await test('Pay@: unauthenticated and wrong-secret calls are refused', async () => {
    const body = { account: phoneRef, amount: '100.00', transactionId: 'T-0' };
    assert.equal((await anon('POST', '/api/payat/notify', body)).status, 401);
    assert.equal((await anon('POST', '/api/payat/notify', body, { 'X-Payat-Secret': 'nope' })).status, 401);
    assert.equal((await anon('POST', '/api/payat/validate', { account: phoneRef })).status, 401);
    assert.equal((await phoneUser('GET', '/api/me')).data.balance, 5000);
  });

  await test('Pay@: validate finds a wallet by reference and by phone number', async () => {
    const a = await anon('POST', '/api/payat/validate', { account: phoneRef }, payatAuth);
    assert.equal(a.data.valid, true);
    assert.ok(!JSON.stringify(a.data).includes('1234567'), 'validate must not leak the full phone number');
    assert.equal((await anon('POST', '/api/payat/validate', { AccountNumber: '0821234567' }, payatAuth)).data.valid, true);
    assert.equal((await anon('POST', '/api/payat/validate', { account: '9999999999' }, payatAuth)).data.valid, false);
  });

  await test('Pay@: notification credits once, duplicates are ignored', async () => {
    const body = { account: phoneRef, amount: '100.50', transactionId: 'T-1001' };
    const r1 = await anon('POST', '/api/payat/notify', body, payatAuth);
    assert.equal(r1.status, 200);
    assert.equal(r1.data.duplicate, false);
    const r2 = await anon('POST', '/api/payat/notify', body, payatAuth);
    assert.equal(r2.status, 200);
    assert.equal(r2.data.duplicate, true);
    assert.equal((await phoneUser('GET', '/api/me')).data.balance, 5000 + 10050);
  });

  await test('Pay@: HMAC-signed requests are accepted, bad signatures refused', async () => {
    const raw = JSON.stringify({ reference: phoneRef, amount: 20, paymentId: 'T-1002' });
    const sig = crypto.createHmac('sha256', PAYAT_SECRET).update(raw).digest('hex');
    assert.equal((await anon('POST', '/api/payat/notify', raw, { 'X-Signature': sig })).status, 200);
    assert.equal((await anon('POST', '/api/payat/notify', raw.replace('T-1002', 'T-1003'), { 'X-Signature': sig })).status, 401);
    assert.equal((await phoneUser('GET', '/api/me')).data.balance, 5000 + 10050 + 2000);
  });

  await test('Pay@: form-encoded body, bad payloads and unknown accounts', async () => {
    const form = `account=${phoneRef}&amount=5.00&transaction_id=T-1004`;
    assert.equal((await anon('POST', '/api/payat/notify', form, { ...payatAuth, 'Content-Type': 'application/x-www-form-urlencoded' })).status, 200);
    assert.equal((await anon('POST', '/api/payat/notify', { account: phoneRef, amount: -5, transactionId: 'T-x1' }, payatAuth)).status, 400);
    assert.equal((await anon('POST', '/api/payat/notify', { account: phoneRef, amount: 5 }, payatAuth)).status, 400);
    assert.equal((await anon('POST', '/api/payat/notify', { account: '9999999999', amount: 5, transactionId: 'T-x2' }, payatAuth)).status, 404);
    assert.equal((await phoneUser('GET', '/api/me')).data.balance, 5000 + 10050 + 2000 + 500);
  });

  await test('transaction history shows credits newest first, balance never negative', async () => {
    const r = await phoneUser('GET', '/api/transactions');
    assert.equal(r.status, 200);
    assert.equal(r.data.transactions.length, 4); // 1 voucher + 3 Pay@ credits
    assert.ok(r.data.transactions.every((t) => t.amount > 0 && t.balance_after >= 0));
    assert.equal(r.data.transactions[0].balance_after, 5000 + 10050 + 2000 + 500);
    assert.equal((await anon('GET', '/api/transactions')).status, 401);
  });

  await test('demo simulate endpoint works for a signed-in user only', async () => {
    assert.equal((await anon('POST', '/api/dev/simulate-payat', { amount: 10 })).status, 401);
    const r = await emailUser('POST', '/api/dev/simulate-payat', { amount: 10 });
    assert.equal(r.status, 200);
    assert.equal(r.data.balance, 5000 + 1000);
  });

  await test('admin summary adds up', async () => {
    const r = await anon('GET', '/api/admin/summary', undefined, admin);
    assert.equal(r.status, 200);
    assert.equal(r.data.redeemed.n, 2);
    assert.equal(r.data.outstanding.n, 0);
  });

  await test('static files: app is served, source and traversal are not', async () => {
    assert.equal((await fetch(BASE + '/')).status, 200);
    assert.equal((await fetch(BASE + '/admin')).status, 200);
    assert.equal((await fetch(BASE + '/server.js')).status, 404);
    assert.equal((await fetch(BASE + '/..%2fserver.js')).status, 404);
    assert.equal((await fetch(BASE + '/%2e%2e/data/test.db')).status, 404);
    const res = await fetch(BASE + '/');
    assert.ok(res.headers.get('content-security-policy').includes("script-src 'self'"));
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}`);
  server.kill();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
