'use strict';
// End-to-end API tests: boots the server on a temp database and exercises the main flows.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd24-'));
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 't.db'), SMS_PROVIDER: 'console', NODE_ENV: 'test', ADMIN_PIN: '112233' };
let srv;

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body, csrf = true } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; if (csrf) headers['x-d24'] = '1'; }
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) { const kv = c.split(';')[0]; const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

async function login(c, phone) {
  const r = await c('/api/auth/otp', { method: 'POST', body: { phone } });
  assert.equal(r.status, 200);
  const v = await c('/api/auth/verify', { method: 'POST', body: { phone, code: r.body.devCode } });
  assert.equal(v.status, 200);
  return v.body.customer;
}

let shim;
before(async () => {
  // TEST_REMOTE=1 runs the whole suite against the Turso (libSQL HTTP) backend via a local shim.
  if (process.env.TEST_REMOTE) {
    shim = await require('./hrana-shim').start(path.join(dir, 'remote.db'), 3998);
    env.TURSO_DATABASE_URL = 'http://localhost:3998';
    env.TURSO_AUTH_TOKEN = 'test-token';
  }
  const flags = ['--disable-warning=ExperimentalWarning'];
  // async (not execFileSync): the shim runs in this process and must keep serving.
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [...flags, 'server/seed.js'], { env, cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('seed failed: ' + code))));
  });
  srv = spawn(process.execPath, [...flags, 'server/index.js'], { env, cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(() => { srv?.kill(); shim?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('rejects invalid phone numbers and requires auth', async () => {
  const c = client();
  assert.equal((await c('/api/auth/otp', { method: 'POST', body: { phone: '12345' } })).status, 400);
  assert.equal((await c('/api/dashboard')).status, 401);
});

test('mutations without the CSRF header are refused', async () => {
  const c = client();
  assert.equal((await c('/api/auth/otp', { method: 'POST', body: { phone: '9000000001' }, csrf: false })).status, 403);
});

test('OTP: wrong codes are counted and locked out; resend is rate limited', async () => {
  const c = client();
  const r = await c('/api/auth/otp', { method: 'POST', body: { phone: '9000000002' } });
  assert.equal(r.status, 200);
  assert.match(r.body.devCode, /^\d{6}$/);
  const wrong = r.body.devCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await c('/api/auth/verify', { method: 'POST', body: { phone: '9000000002', code: wrong } })).status, 400);
  assert.equal((await c('/api/auth/verify', { method: 'POST', body: { phone: '9000000002', code: r.body.devCode } })).status, 429);
  assert.equal((await c('/api/auth/otp', { method: 'POST', body: { phone: '9000000002' } })).status, 429);
});

test('new customer: profile, vehicles, isolation from other customers', async () => {
  const c = client();
  const me = await login(c, '+91 90000 00003');
  assert.equal(me.phone, '+919000000003');
  assert.equal(me.name, null);
  assert.equal((await c('/api/me', { method: 'PATCH', body: { name: 'Asha Rao' } })).status, 200);
  const v = await c('/api/vehicles', { method: 'POST', body: { kind: 'car', make: 'Toyota', model: 'Fortuner', reg_no: 'ka 19 ab 1234', year: 2024 } });
  assert.equal(v.status, 200);
  assert.equal(v.body.vehicle.reg_no, 'KA 19 AB 1234');
  assert.equal((await c('/api/vehicles', { method: 'POST', body: { make: 'X', model: 'Y', reg_no: 'KA 19 AB 1234' } })).status, 400);
  // cannot read the demo customer's invoice
  assert.equal((await c('/api/invoices/1')).status, 404);
  assert.equal((await c(`/api/vehicles/${v.body.vehicle.id}`, { method: 'DELETE' })).status, 200);
});

// One session for the demo customer (a second OTP within 30s is correctly rate limited).
const demo = client();
test('demo customer sees invoices, warranties, missed and upcoming services', async () => {
  const c = demo;
  await login(c, '9876543210');
  const d = (await c('/api/dashboard')).body;
  assert.equal(d.missed.length, 1);
  assert.ok(d.upcoming.length >= 1);
  assert.equal(d.warranties.length, 3);
  assert.ok(d.warranties.some((w) => w.kind === 'ppf' && w.brand === 'Garware'));
  const n = (await c('/api/notifications')).body.notifications;
  assert.ok(n.some((x) => x.kind === 'missed'));
  assert.ok(n.some((x) => x.kind === 'upcoming'));
  const inv = (await c('/api/invoices')).body.invoices;
  assert.equal(inv.length, 4);
  assert.equal(inv[0].total, inv[0].subtotal - inv[0].discount + inv[0].tax);
});

test('booking a missed service, slot capacity, admin confirm and complete', async () => {
  const c = demo;
  const missed = (await c('/api/dashboard')).body.missed[0];
  // next non-Sunday date
  let date = new Date(Date.now() + 86400000 * 2);
  if (date.getUTCDay() === 0) date = new Date(date.getTime() + 86400000);
  date = date.toISOString().slice(0, 10);
  const b = await c('/api/bookings', { method: 'POST', body: { vehicle_id: missed.vehicle_id, service_id: missed.id, service: 'Ceramic coating inspection', date, slot: '09:30' } });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal((await c('/api/dashboard')).body.missed.length, 0);
  // second request fills the slot (capacity 2), third is refused
  assert.equal((await c('/api/bookings', { method: 'POST', body: { vehicle_id: missed.vehicle_id, service: 'Car wash', date, slot: '09:30' } })).status, 200);
  assert.equal((await c('/api/bookings', { method: 'POST', body: { vehicle_id: missed.vehicle_id, service: 'Car wash', date, slot: '09:30' } })).status, 409);

  const a = client();
  assert.equal((await a('/api/admin/login', { method: 'POST', body: { pin: '000000' } })).status, 401);
  assert.equal((await a('/api/admin/login', { method: 'POST', body: { pin: '112233' } })).status, 200);
  const id = b.body.booking.id;
  assert.equal((await a(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: 'completed' } })).status, 400);
  assert.equal((await a(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: 'confirmed' } })).status, 200);
  assert.equal((await a(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: 'completed' } })).status, 200);
  const n = (await c('/api/notifications')).body.notifications;
  assert.ok(n.some((x) => x.title === 'Booking confirmed'));
});

test('admin issues invoice and warranty; schedule is generated', async () => {
  const a = client();
  await a('/api/admin/login', { method: 'POST', body: { pin: '112233' } });
  const cust = (await a('/api/admin/customers', { method: 'POST', body: { phone: '9000000009', name: 'Kiran' } })).body.customer;
  const v = (await a(`/api/admin/customers/${cust.id}/vehicles`, { method: 'POST', body: { make: 'Hyundai', model: 'Creta', reg_no: 'KA 20 Z 9' } })).body.vehicle;
  const inv = await a('/api/admin/invoices', { method: 'POST', body: { customer_id: cust.id, vehicle_id: v.id, items: [{ desc: 'Ceramic coating', qty: 1, rate: 20000 }], discount: 1000 } });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.invoice.total, (2000000 - 100000) * 1.18);
  const w = await a('/api/admin/warranties', { method: 'POST', body: { customer_id: cust.id, vehicle_id: v.id, kind: 'ceramic', brand: 'Koch-Chemie', product: 'Signature', years: 3, interval_months: 6, starts_on: '2026-01-01' } });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.warranty.ends_on, '2028-12-31');
  assert.equal(w.body.warranty.services.length, 5);
  assert.equal((await a('/api/admin/warranties', { method: 'POST', body: { customer_id: cust.id, vehicle_id: v.id, kind: 'ppf', brand: 'Koch-Chemie', product: 'x', years: 5 } })).status, 400);
  // customer endpoints do not accept admin session
  assert.equal((await a('/api/dashboard')).status, 401);
});

test('booking options follow the vehicle class', async () => {
  const c = demo;
  const { vehicles } = (await c('/api/vehicles')).body;
  const bike = vehicles.find((v) => v.kind === 'bike');
  const studio = (await c('/api/studio')).body;
  const bikeServices = studio.catalog.filter((s) => s.kinds.includes('bike')).map((s) => s.name);
  assert.ok(bikeServices.includes('Bike wash'));
  assert.ok(!bikeServices.includes('Interior detailing'));
  let date = new Date(Date.now() + 86400000 * 3);
  if (date.getUTCDay() === 0) date = new Date(date.getTime() + 86400000);
  date = date.toISOString().slice(0, 10);
  const no = await c('/api/bookings', { method: 'POST', body: { vehicle_id: bike.id, service: 'Interior detailing', date, slot: studio.slots[2] } });
  assert.equal(no.status, 400);
  assert.match(no.body.error, /motorcycles/);
  assert.equal((await c('/api/bookings', { method: 'POST', body: { vehicle_id: bike.id, service: 'Bike wash', date, slot: studio.slots[2] } })).status, 200);
});
