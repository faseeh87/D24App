'use strict';
// Super Admin / Admin roles, discount approval, payments + automatic warranties,
// inventory deduction and booking stop, finance, marketing analysis.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd24s-'));
const env = { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 's.db'), SMS_PROVIDER: 'console', NODE_ENV: 'test', ADMIN_PIN: '445566' };
let srv, shim;

function client() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const headers = { cookie };
    if (method !== 'GET') { headers['content-type'] = 'application/json'; headers['x-d24'] = '1'; }
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; const [k] = kv.split('='); cookie = cookie.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}
const nextWeekday = (days) => { let d = new Date(Date.now() + 86400000 * days); if (d.getUTCDay() === 0) d = new Date(d.getTime() + 86400000); return d.toISOString().slice(0, 10); };

const owner = client();
const admin = client();
const customer = client();
let cust, car, bike;

before(async () => {
  if (process.env.TEST_REMOTE) {
    shim = await require('./hrana-shim').start(path.join(dir, 'remote.db'), 3996);
    env.TURSO_DATABASE_URL = 'http://localhost:3996';
    env.TURSO_AUTH_TOKEN = 't';
  }
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.equal((await owner('/api/admin/login', { method: 'POST', body: { pin: '445566' } })).body.staff.role, 'super');
  // customer signs in and adds a car and a bike
  const o = await customer('/api/auth/otp', { method: 'POST', body: { phone: '9811111111' } });
  cust = (await customer('/api/auth/verify', { method: 'POST', body: { phone: '9811111111', code: o.body.devCode } })).body.customer;
  await customer('/api/me', { method: 'PATCH', body: { name: 'Test Owner' } });
  car = (await customer('/api/vehicles', { method: 'POST', body: { kind: 'car', make: 'Honda', model: 'City', reg_no: 'KA 19 AA 1111' } })).body.vehicle;
  bike = (await customer('/api/vehicles', { method: 'POST', body: { kind: 'bike', make: 'KTM', model: 'Duke', reg_no: 'KA 19 BB 2222' } })).body.vehicle;
});
after(() => { srv?.kill(); shim?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('Super Admin creates an Admin; roles are enforced', async () => {
  assert.equal((await owner('/api/admin/staff', { method: 'POST', body: { name: 'Rakesh', pin: '445566' } })).status, 400); // PIN in use
  assert.equal((await owner('/api/admin/staff', { method: 'POST', body: { name: 'Rakesh', pin: '778899' } })).status, 200);
  const l = await admin('/api/admin/login', { method: 'POST', body: { pin: '778899' } });
  assert.equal(l.body.staff.role, 'admin');
  assert.equal((await admin('/api/admin/finance')).status, 403);
  assert.equal((await admin('/api/admin/staff')).status, 403);
  assert.equal((await admin(`/api/admin/customers/${cust.id}/phone`, { method: 'POST', body: { phone: '9822222222' } })).status, 403);
  const ov = await admin('/api/admin/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.revenue, undefined); // no revenue for Admin
  assert.ok((await owner('/api/admin/overview')).body.revenue);
});

test('Admin cannot discount without approval; approved request is applied once', async () => {
  const items = [{ desc: 'Car wash', qty: 1, rate: 500 }];
  const denied = await admin('/api/admin/invoices', { method: 'POST', body: { customer_id: cust.id, vehicle_id: car.id, items, discount: 100 } });
  assert.equal(denied.status, 403);
  const req = (await admin('/api/admin/discounts', { method: 'POST', body: { customer_id: cust.id, vehicle_id: car.id, amount: 100, reason: 'Loyal customer' } })).body.request;
  assert.equal(req.status, 'pending');
  const n = (await owner('/api/admin/notifications')).body.notifications;
  assert.ok(n.some((x) => x.kind === 'discount'));
  // not yet approved
  assert.equal((await admin('/api/admin/invoices', { method: 'POST', body: { customer_id: cust.id, items, discount_request_id: req.id } })).status, 400);
  assert.equal((await admin(`/api/admin/discounts/${req.id}/decide`, { method: 'POST', body: { decision: 'approve' } })).status, 403);
  assert.equal((await owner(`/api/admin/discounts/${req.id}/decide`, { method: 'POST', body: { decision: 'approve', amount: 50 } })).status, 200);
  const inv = await admin('/api/admin/invoices', { method: 'POST', body: { customer_id: cust.id, vehicle_id: car.id, items, discount_request_id: req.id } });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.invoice.discount, 5000);
  assert.equal(inv.body.invoice.payment_status, 'unpaid');
  // used up
  assert.equal((await admin('/api/admin/invoices', { method: 'POST', body: { customer_id: cust.id, items, discount_request_id: req.id } })).status, 400);
});

const ceramic = { kind: 'ceramic', brand: 'Koch-Chemie', product: 'Signature coat', years: 3, interval_months: 6 };

test('Warranty is issued automatically when a no-discount invoice is fully paid', async () => {
  const inv = (await admin('/api/admin/invoices', { method: 'POST', body: {
    customer_id: cust.id, vehicle_id: car.id, items: [{ desc: 'Ceramic coating', qty: 1, rate: 30000, warranty: ceramic }] } })).body.invoice;
  let w = (await customer('/api/warranties')).body.warranties;
  assert.equal(w.length, 0);
  const part = await admin(`/api/admin/invoices/${inv.id}/payments`, { method: 'POST', body: { amount: 10000, mode: 'UPI' } });
  assert.equal(part.body.warranties_issued, 0);
  const full = await admin(`/api/admin/invoices/${inv.id}/payments`, { method: 'POST', body: { amount: 'full', mode: 'Card' } });
  assert.equal(full.body.warranties_issued, 1);
  w = (await customer('/api/warranties')).body.warranties;
  assert.equal(w.length, 1);
  assert.equal(w[0].auto, 1);
  assert.equal(w[0].services.length, 5);
  assert.equal((await admin(`/api/admin/invoices/${inv.id}/payments`, { method: 'POST', body: { amount: 'full' } })).status, 400); // already paid
});

test('Discounted invoice: no automatic warranty; only Super Admin can issue it', async () => {
  const inv = (await owner('/api/admin/invoices', { method: 'POST', body: {
    customer_id: cust.id, vehicle_id: bike.id, discount: 500, items: [{ desc: 'Bike ceramic', qty: 1, rate: 6000, warranty: ceramic }] } })).body.invoice;
  const pay = await owner(`/api/admin/invoices/${inv.id}/payments`, { method: 'POST', body: { amount: 'full' } });
  assert.equal(pay.body.warranties_issued, 0);
  const b = (await admin(`/api/admin/customers/${cust.id}`)).body;
  const pending = b.invoices.find((i) => i.id === inv.id).pending_warranties;
  assert.equal(pending.length, 1);
  const body = { customer_id: cust.id, vehicle_id: bike.id, invoice_id: inv.id, invoice_line: pending[0].line, ...ceramic };
  assert.equal((await admin('/api/admin/warranties', { method: 'POST', body })).status, 403);
  assert.equal((await owner('/api/admin/warranties', { method: 'POST', body })).status, 200);
  assert.equal((await owner('/api/admin/warranties', { method: 'POST', body })).status, 400); // no duplicate for same line
});

test('Inventory: bookings stop below one vehicle; completion deducts; low-stock alert', async () => {
  // 100 ml shampoo, reorder at 50. Car wash uses 40 ml per car.
  assert.equal((await admin('/api/admin/inventory/items', { method: 'POST', body: { category: 'Shampoo', brand: 'Koch-Chemie', sub_brand: 'Gsf Gentle Snow Foam', pack_size: 1000, quantity: 100, reorder_level: 50 } })).status, 403);
  assert.equal((await owner('/api/admin/inventory/items', { method: 'POST', body: { category: 'Shampoo', brand: 'Koch-Chemie', sub_brand: 'Gsf Gentle Snow Foam', pack_size: 1000, quantity: 100, reorder_level: 50 } })).status, 200);
  const slots = (await customer('/api/studio')).body.slots;
  const book = (date) => customer('/api/bookings', { method: 'POST', body: { vehicle_id: car.id, service: 'Car wash', date, slot: slots[0] } });
  const b1 = (await book(nextWeekday(2))).body.booking;
  const b2 = await book(nextWeekday(3));
  assert.equal(b2.status, 200);                 // 80 ml reserved
  const b3 = await book(nextWeekday(4));
  assert.equal(b3.status, 409);                 // only 20 ml free: booking stopped
  const av = (await customer(`/api/service-availability?vehicle_id=${car.id}`)).body;
  assert.ok(av.unavailable.includes('Car wash'));
  assert.ok(!av.unavailable.includes('Paint correction')); // untracked category stays open
  const bikeAv = (await customer(`/api/service-availability?vehicle_id=${bike.id}`)).body;
  assert.ok(!bikeAv.unavailable.includes('Bike wash')); // 20 ml free, a bike wash needs 20 ml
  // complete booking 1 → deduct 40 ml, now 60 ml
  await admin(`/api/admin/bookings/${b1.id}/status`, { method: 'POST', body: { status: 'confirmed' } });
  const usage = (await admin(`/api/admin/bookings/${b1.id}/usage`)).body.usage;
  assert.equal(usage[0].amount, 40);
  const done = await admin(`/api/admin/bookings/${b1.id}/status`, { method: 'POST', body: { status: 'completed', picks: { Shampoo: usage[0].items[0].id } } });
  assert.equal(done.status, 200);
  let inv = (await admin('/api/admin/inventory')).body;
  assert.equal(inv.items[0].quantity, 60);
  // cancel booking 2 → free again; complete a new one to go below reorder level
  const b2id = b2.body.booking.id;
  await admin(`/api/admin/bookings/${b2id}/status`, { method: 'POST', body: { status: 'confirmed' } });
  await admin(`/api/admin/bookings/${b2id}/status`, { method: 'POST', body: { status: 'completed' } });
  inv = (await admin('/api/admin/inventory')).body;
  assert.equal(inv.items[0].quantity, 20);
  assert.ok(inv.paused.some((p) => p.service === 'Car wash'));
  const n = (await owner('/api/admin/notifications')).body.notifications;
  assert.ok(n.some((x) => x.title.startsWith('Restock Koch-Chemie')));
  assert.ok(n.some((x) => x.title.startsWith('Bookings paused: Car wash')));
  assert.ok(!(await admin('/api/admin/notifications')).body.notifications.some((x) => x.kind === 'inventory')); // Super Admin only
  // Admin records stock received (with cost → inventory expense); bookings reopen
  const itemId = inv.items[0].id;
  assert.equal((await admin(`/api/admin/inventory/items/${itemId}/stock`, { method: 'POST', body: { mode: 'count', quantity: 500 } })).status, 403);
  assert.equal((await admin(`/api/admin/inventory/items/${itemId}/stock`, { method: 'POST', body: { quantity: 1000, cost: 2400 } })).status, 200);
  assert.equal((await book(nextWeekday(5))).status, 200);
});

test('Finance: revenue by period, expenses and forecast (Super Admin only)', async () => {
  await owner('/api/admin/expenses', { method: 'POST', body: { category: 'rent', amount: 35000 } });
  await owner('/api/admin/expenses', { method: 'POST', body: { category: 'salary', amount: 60000 } });
  const f = (await owner('/api/admin/finance')).body;
  assert.ok(f.revenue.day.collected > 0);
  assert.equal(f.revenue.month.collected >= f.revenue.day.collected, true);
  assert.ok(f.revenue.year.expenses >= 9500000 + 240000);
  const rent = f.forecast.lines.find((l) => l.category === 'rent');
  assert.equal(rent.forecast, 3500000);
  assert.ok(f.forecast.total >= 3500000 + 6000000);
});

test('Super Admin changes a customer mobile number; old sessions end', async () => {
  const r = await owner(`/api/admin/customers/${cust.id}/phone`, { method: 'POST', body: { phone: '98222 22222' } });
  assert.equal(r.status, 200);
  assert.equal((await customer('/api/me')).status, 401);
  const o = await customer('/api/auth/otp', { method: 'POST', body: { phone: '9822222222' } });
  const v = await customer('/api/auth/verify', { method: 'POST', body: { phone: '9822222222', code: o.body.devCode } });
  assert.equal(v.body.customer.id, cust.id);
});

test('Marketing analysis flags an engagement drop and a posting gap', () => {
  const { analyseInstagram } = require('../server/social');
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const posts = [
    { date: day(10), likes: 10, comments: 1 },
    ...[20, 30, 40, 50, 60].map((n) => ({ date: day(n), likes: 100, comments: 10 })),
  ];
  const a = analyseInstagram({ followers: 1000, posts });
  assert.ok(a.issues.includes('engagement'));
  assert.ok(a.issues.includes('posting-gap'));
  assert.equal(a.metrics.er_baseline, 11);
});
