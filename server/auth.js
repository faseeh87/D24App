'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');
const sms = require('./sms');
const { normalisePhone, HttpError, bad } = require('./util');
const { setCookie } = require('./http');

const CUSTOMER_COOKIE = 'd24_s';
const ADMIN_COOKIE = 'd24_a';
const now = () => Math.floor(Date.now() / 1000);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const otpHash = (phone, code) => crypto.createHmac('sha256', config.secret).update(phone + ':' + code).digest('hex');

// ---- in-memory rate limiter (per process) ----
const buckets = new Map();
function limit(key, max, windowSec) {
  const t = now();
  const b = buckets.get(key);
  if (!b || t - b.start >= windowSec) { buckets.set(key, { start: t, count: 1 }); return; }
  if (++b.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.start > 3600) buckets.delete(k); }, 600000).unref();

// ---- sessions ----
function createSession(res, role, customerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = role === 'admin' ? config.session.adminHours * 3600 : config.session.customerDays * 86400;
  db.run('INSERT INTO sessions (token_hash, role, customer_id, expires_at) VALUES (?, ?, ?, ?)', sha(token), role, customerId ?? null, now() + ttl);
  setCookie(res, role === 'admin' ? ADMIN_COOKIE : CUSTOMER_COOKIE, token, { maxAge: ttl });
}

function readSession(ctx, role) {
  const token = ctx.cookies[role === 'admin' ? ADMIN_COOKIE : CUSTOMER_COOKIE];
  if (!token) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ? AND role = ?', sha(token), role);
  if (!s) return null;
  if (s.expires_at < now()) { db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash); return null; }
  return s;
}

function destroySession(ctx, role) {
  const name = role === 'admin' ? ADMIN_COOKIE : CUSTOMER_COOKIE;
  const token = ctx.cookies[name];
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  setCookie(ctx.res, name, '', { clear: true });
}

/** Middleware: requires a signed-in customer, sets ctx.customer. */
function requireCustomer(ctx) {
  const s = readSession(ctx, 'customer');
  if (!s) throw new HttpError(401, 'Please sign in');
  ctx.customer = db.get('SELECT * FROM customers WHERE id = ?', s.customer_id);
  if (!ctx.customer) throw new HttpError(401, 'Please sign in');
}

function requireAdmin(ctx) {
  if (!readSession(ctx, 'admin')) throw new HttpError(401, 'Staff sign-in required');
}

// ---- OTP ----
async function requestOtp(ctx) {
  const phone = normalisePhone(ctx.body.phone);
  if (!phone) throw bad('Enter a valid 10-digit Indian mobile number');
  limit('otp-ip:' + ctx.ip, 20, 3600);

  const t = now();
  const row = db.get('SELECT * FROM otps WHERE phone = ?', phone);
  if (row?.sent_at && t - row.sent_at < config.otp.resendSec) {
    throw new HttpError(429, `Please wait ${config.otp.resendSec - (t - row.sent_at)}s before requesting another code`);
  }
  let windowStart = row?.window_start || t;
  let windowCount = row?.window_count || 0;
  if (t - windowStart >= 3600) { windowStart = t; windowCount = 0; }
  if (windowCount >= config.otp.maxPerHour) throw new HttpError(429, 'Too many codes requested. Please try again in an hour.');

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.run(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_at, window_start, window_count)
          VALUES (?, ?, ?, 0, ?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0,
          sent_at=excluded.sent_at, window_start=excluded.window_start, window_count=excluded.window_count`,
  phone, otpHash(phone, code), t + config.otp.ttlSec, t, windowStart, windowCount + 1);

  try { await sms.sendOtp(phone, code); }
  catch (e) {
    console.error(e);
    db.run('UPDATE otps SET sent_at = NULL WHERE phone = ?', phone);
    throw new HttpError(502, 'We could not send the SMS right now. Please try again shortly.');
  }
  const out = { ok: true, phone, resendIn: config.otp.resendSec, expiresIn: config.otp.ttlSec };
  // Development convenience only: surface the code when no real SMS provider is configured.
  if (sms.isDevProvider() && !config.production) out.devCode = code;
  return out;
}

function verifyOtp(ctx) {
  const phone = normalisePhone(ctx.body.phone);
  const code = String(ctx.body.code || '').replace(/\D/g, '');
  if (!phone || code.length !== 6) throw bad('Enter the 6-digit code');
  limit('verify-ip:' + ctx.ip, 40, 3600);

  const row = db.get('SELECT * FROM otps WHERE phone = ?', phone);
  if (!row || !row.code_hash || row.expires_at < now()) throw bad('This code has expired. Request a new one.');
  if (row.attempts >= config.otp.maxAttempts) throw new HttpError(429, 'Too many incorrect attempts. Request a new code.');

  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(otpHash(phone, code), 'hex'));
  if (!ok) {
    db.run('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?', phone);
    const left = config.otp.maxAttempts - row.attempts - 1;
    throw bad(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.');
  }
  db.run('UPDATE otps SET code_hash = NULL, attempts = 0 WHERE phone = ?', phone);

  let customer = db.get('SELECT * FROM customers WHERE phone = ?', phone);
  if (!customer) {
    const r = db.run('INSERT INTO customers (phone) VALUES (?)', phone);
    customer = db.get('SELECT * FROM customers WHERE id = ?', r.lastInsertRowid);
  }
  createSession(ctx.res, 'customer', customer.id);
  return { ok: true, customer };
}

function adminLogin(ctx) {
  limit('admin-ip:' + ctx.ip, 10, 900);
  const pin = String(ctx.body.pin || '');
  const given = crypto.createHash('sha256').update(pin).digest();
  if (!crypto.timingSafeEqual(given, config.adminPinHash)) throw new HttpError(401, 'Incorrect PIN');
  createSession(ctx.res, 'admin');
  return { ok: true };
}

// Periodically clear expired sessions.
setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ?', now()), 3600000).unref();

module.exports = { requestOtp, verifyOtp, adminLogin, requireCustomer, requireAdmin, destroySession, readSession };
