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

// ---- rate limiter (stored in the database so it holds across serverless instances) ----
async function limit(key, max, windowSec) {
  const t = now();
  const row = await db.get(
    `INSERT INTO rate_limits (key, start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN ? - rate_limits.start >= ? THEN 1 ELSE rate_limits.count + 1 END,
       start = CASE WHEN ? - rate_limits.start >= ? THEN ? ELSE rate_limits.start END
     RETURNING count`, key, t, t, windowSec, t, windowSec, t);
  if (row && row.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

// ---- sessions ----
async function createSession(res, role, customerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = role === 'admin' ? config.session.adminHours * 3600 : config.session.customerDays * 86400;
  await db.run('INSERT INTO sessions (token_hash, role, customer_id, expires_at) VALUES (?, ?, ?, ?)', sha(token), role, customerId ?? null, now() + ttl);
  setCookie(res, role === 'admin' ? ADMIN_COOKIE : CUSTOMER_COOKIE, token, { maxAge: ttl });
}

async function readSession(ctx, role) {
  const token = ctx.cookies[role === 'admin' ? ADMIN_COOKIE : CUSTOMER_COOKIE];
  if (!token) return null;
  const s = await db.get('SELECT * FROM sessions WHERE token_hash = ? AND role = ?', sha(token), role);
  if (!s) return null;
  if (s.expires_at < now()) { await db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash); return null; }
  return s;
}

async function destroySession(ctx, role) {
  const name = role === 'admin' ? ADMIN_COOKIE : CUSTOMER_COOKIE;
  const token = ctx.cookies[name];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  setCookie(ctx.res, name, '', { clear: true });
}

/** Middleware: requires a signed-in customer, sets ctx.customer. */
async function requireCustomer(ctx) {
  const s = await readSession(ctx, 'customer');
  if (!s) throw new HttpError(401, 'Please sign in');
  ctx.customer = await db.get('SELECT * FROM customers WHERE id = ?', s.customer_id);
  if (!ctx.customer) throw new HttpError(401, 'Please sign in');
}

async function requireAdmin(ctx) {
  if (!(await readSession(ctx, 'admin'))) throw new HttpError(401, 'Staff sign-in required');
}

// ---- OTP ----
async function requestOtp(ctx) {
  const phone = normalisePhone(ctx.body.phone);
  if (!phone) throw bad('Enter a valid 10-digit Indian mobile number');
  await limit('otp-ip:' + ctx.ip, 20, 3600);

  const t = now();
  const row = await db.get('SELECT * FROM otps WHERE phone = ?', phone);
  if (row?.sent_at && t - row.sent_at < config.otp.resendSec) {
    throw new HttpError(429, `Please wait ${config.otp.resendSec - (t - row.sent_at)}s before requesting another code`);
  }
  let windowStart = row?.window_start || t;
  let windowCount = row?.window_count || 0;
  if (t - windowStart >= 3600) { windowStart = t; windowCount = 0; }
  if (windowCount >= config.otp.maxPerHour) throw new HttpError(429, 'Too many codes requested. Please try again in an hour.');

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.run(`INSERT INTO otps (phone, code_hash, expires_at, attempts, sent_at, window_start, window_count)
          VALUES (?, ?, ?, 0, ?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0,
          sent_at=excluded.sent_at, window_start=excluded.window_start, window_count=excluded.window_count`,
  phone, otpHash(phone, code), t + config.otp.ttlSec, t, windowStart, windowCount + 1);

  try { await sms.sendOtp(phone, code); }
  catch (e) {
    console.error(e);
    await db.run('UPDATE otps SET sent_at = NULL WHERE phone = ?', phone);
    throw new HttpError(502, 'We could not send the SMS right now. Please try again shortly.');
  }
  const out = { ok: true, phone, resendIn: config.otp.resendSec, expiresIn: config.otp.ttlSec };
  // Testing convenience only: show the code when no SMS provider is configured.
  if (sms.isDevProvider() && (!config.production || config.otpOnScreen)) out.devCode = code;
  return out;
}

async function verifyOtp(ctx) {
  const phone = normalisePhone(ctx.body.phone);
  const code = String(ctx.body.code || '').replace(/\D/g, '');
  if (!phone || code.length !== 6) throw bad('Enter the 6-digit code');
  await limit('verify-ip:' + ctx.ip, 40, 3600);

  const row = await db.get('SELECT * FROM otps WHERE phone = ?', phone);
  if (!row || !row.code_hash || row.expires_at < now()) throw bad('This code has expired. Request a new one.');
  if (row.attempts >= config.otp.maxAttempts) throw new HttpError(429, 'Too many incorrect attempts. Request a new code.');

  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(otpHash(phone, code), 'hex'));
  if (!ok) {
    await db.run('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?', phone);
    const left = config.otp.maxAttempts - row.attempts - 1;
    throw bad(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.');
  }
  await db.run('UPDATE otps SET code_hash = NULL, attempts = 0 WHERE phone = ?', phone);

  let customer = await db.get('SELECT * FROM customers WHERE phone = ?', phone);
  if (!customer) {
    const r = await db.run('INSERT INTO customers (phone) VALUES (?)', phone);
    customer = await db.get('SELECT * FROM customers WHERE id = ?', r.lastInsertRowid);
  }
  await createSession(ctx.res, 'customer', customer.id);
  return { ok: true, customer };
}

async function adminLogin(ctx) {
  await limit('admin-ip:' + ctx.ip, 10, 900);
  const pin = String(ctx.body.pin || '');
  const given = crypto.createHash('sha256').update(pin).digest();
  if (!crypto.timingSafeEqual(given, config.adminPinHash)) throw new HttpError(401, 'Incorrect PIN');
  await createSession(ctx.res, 'admin');
  return { ok: true };
}

/** Housekeeping, run by the daily cron / hourly local sweep. */
async function cleanup() {
  const t = now();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', t);
  await db.run('DELETE FROM rate_limits WHERE start < ?', t - 86400);
}

module.exports = { requestOtp, verifyOtp, adminLogin, requireCustomer, requireAdmin, destroySession, readSession, cleanup };
