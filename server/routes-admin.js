'use strict';
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const D = require('./domain');
const { cleanVehicle } = require('./routes-customer');
const { today, addDays, addMonths, isDate, normalisePhone, str, fmtDate, bad, HttpError } = require('./util');

const rupeesToPaise = (v) => Math.round(Number(v) * 100);

async function getCustomer(id) {
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', Number(id));
  if (!customer) throw new HttpError(404, 'Customer not found');
  return customer;
}

async function customerBundle(id) {
  const customer = await getCustomer(id);
  const [vehicles, inv, war, svc, bk] = await Promise.all([
    db.all('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id', customer.id),
    db.all('SELECT * FROM invoices WHERE customer_id = ? ORDER BY issued_on DESC, id DESC', customer.id),
    db.all('SELECT * FROM warranties WHERE customer_id = ? ORDER BY starts_on DESC', customer.id),
    db.all(`SELECT s.*, v.make, v.model, v.reg_no FROM services s JOIN vehicles v ON v.id = s.vehicle_id
            WHERE s.customer_id = ? ORDER BY s.due_on`, customer.id),
    db.all('SELECT * FROM bookings WHERE customer_id = ? ORDER BY date DESC', customer.id),
  ]);
  return {
    customer,
    vehicles,
    invoices: await D.mapAll(inv, D.invoiceView),
    warranties: await D.mapAll(war, D.warrantyView),
    services: svc.map(D.serviceView),
    bookings: await D.mapAll(bk, D.bookingView),
  };
}

async function bookingRow(b) {
  const [view, c] = await Promise.all([D.bookingView(b), db.get('SELECT name, phone FROM customers WHERE id = ?', b.customer_id)]);
  return { ...view, customer_name: c?.name, customer_phone: c?.phone };
}

module.exports = function register(r) {
  const staff = auth.requireAdmin;

  r.post('/api/admin/login', auth.adminLogin);
  r.post('/api/admin/logout', async (ctx) => { await auth.destroySession(ctx, 'admin'); return { ok: true }; });
  r.get('/api/admin/session', staff, () => ({ ok: true, studio: config.studio, services: config.services, gstRate: config.gstRate }));

  r.get('/api/admin/overview', staff, async () => {
    const t = today();
    const svc = async (where, ...p) => (await db.all(`SELECT s.*, v.make, v.model, v.reg_no, c.name AS customer_name, c.phone AS customer_phone
      FROM services s JOIN vehicles v ON v.id = s.vehicle_id JOIN customers c ON c.id = s.customer_id WHERE ${where} ORDER BY s.due_on`, ...p)).map(D.serviceView);
    const [customers, active, revenue, requests, schedule, missed, dueSoon] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM customers'),
      db.get('SELECT COUNT(*) AS n FROM warranties WHERE ends_on >= ?', t),
      db.get(`SELECT COALESCE(SUM(total),0) AS n FROM invoices WHERE substr(issued_on,1,7) = ?`, t.slice(0, 7)),
      db.all(`SELECT * FROM bookings WHERE status = 'requested' ORDER BY date, slot`),
      db.all(`SELECT * FROM bookings WHERE status = 'confirmed' AND date BETWEEN ? AND ? ORDER BY date, slot`, t, addDays(t, 7)),
      svc(`s.status = 'due' AND s.due_on < ?`, t),
      svc(`s.status = 'due' AND s.due_on BETWEEN ? AND ?`, t, addDays(t, config.reminders.upcomingDays)),
    ]);
    return {
      today: t,
      counts: { customers: customers.n, active_warranties: active.n, revenue_month: revenue.n },
      requests: await D.mapAll(requests, bookingRow),
      schedule: await D.mapAll(schedule, bookingRow),
      missed,
      due_soon: dueSoon,
    };
  });

  // ---- customers ----
  r.get('/api/admin/customers', staff, async (ctx) => {
    const q = str(ctx.query.q, 60);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    const digits = q.replace(/\D/g, '');
    const rows = await db.all(`SELECT c.*, (SELECT COUNT(*) FROM vehicles v WHERE v.customer_id = c.id) AS vehicles,
        (SELECT GROUP_CONCAT(reg_no, ', ') FROM vehicles v WHERE v.customer_id = c.id) AS regs
      FROM customers c
      WHERE ? = '' OR c.name LIKE ? OR (? != '' AND c.phone LIKE ?) OR EXISTS (SELECT 1 FROM vehicles v WHERE v.customer_id = c.id AND v.reg_no LIKE ?)
      ORDER BY c.id DESC LIMIT 100`, q, like, digits, `%${digits}%`, like.toUpperCase());
    return { customers: rows };
  });

  r.post('/api/admin/customers', staff, async (ctx) => {
    const phone = normalisePhone(ctx.body.phone);
    if (!phone) throw bad('Enter a valid mobile number');
    const existing = await db.get('SELECT * FROM customers WHERE phone = ?', phone);
    if (existing) return { customer: existing, existed: true };
    const res = await db.run('INSERT INTO customers (phone, name, email) VALUES (?, ?, ?)', phone, str(ctx.body.name, 80) || null, str(ctx.body.email, 120) || null);
    return { customer: await db.get('SELECT * FROM customers WHERE id = ?', res.lastInsertRowid) };
  });

  r.get('/api/admin/customers/:id', staff, (ctx) => customerBundle(ctx.params.id));

  r.patch('/api/admin/customers/:id', staff, async (ctx) => {
    const c = await getCustomer(ctx.params.id);
    await db.run('UPDATE customers SET name = ?, email = ? WHERE id = ?', str(ctx.body.name, 80) || null, str(ctx.body.email, 120) || null, c.id);
    return { ok: true };
  });

  r.post('/api/admin/customers/:id/vehicles', staff, async (ctx) => {
    const cid = (await getCustomer(ctx.params.id)).id;
    const v = cleanVehicle(ctx.body);
    if (await db.get('SELECT 1 AS x FROM vehicles WHERE customer_id = ? AND reg_no = ?', cid, v.reg_no)) throw bad('Vehicle already exists for this customer');
    const res = await db.run('INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no, vin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      cid, v.kind, v.make, v.model, v.year, v.colour, v.reg_no, v.vin);
    return { vehicle: await db.get('SELECT * FROM vehicles WHERE id = ?', res.lastInsertRowid) };
  });

  // ---- invoices ----
  r.post('/api/admin/invoices', staff, async (ctx) => {
    const b = ctx.body;
    const customer = await getCustomer(b.customer_id);
    const vehicle = b.vehicle_id ? await db.get('SELECT * FROM vehicles WHERE id = ? AND customer_id = ?', Number(b.vehicle_id), customer.id) : null;
    if (b.vehicle_id && !vehicle) throw bad('Vehicle not found');
    const issued = isDate(b.issued_on) ? b.issued_on : today();
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map((i) => ({
      desc: str(i.desc, 160), qty: Math.max(1, Math.round(Number(i.qty) || 1)), rate: rupeesToPaise(i.rate),
    })).filter((i) => i.desc && i.rate > 0);
    if (!items.length) throw bad('Add at least one line item with a price');
    const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
    const discount = Math.min(subtotal, Math.max(0, rupeesToPaise(b.discount || 0)));
    const taxRate = b.tax_rate === undefined || b.tax_rate === '' ? config.gstRate : Math.max(0, Math.min(28, Number(b.tax_rate) || 0));
    const tax = Math.round((subtotal - discount) * taxRate / 100);
    const total = subtotal - discount + tax;
    const status = b.status === 'due' ? 'due' : 'paid';
    const inv = await db.tx(async (tx) => {
      const no = await D.nextInvoiceNo(tx, issued);
      const res = await tx.run(`INSERT INTO invoices (invoice_no, customer_id, vehicle_id, issued_on, items, subtotal, discount, tax_rate, tax, total, status, paid_on, payment_mode, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      no, customer.id, vehicle?.id ?? null, issued, JSON.stringify(items), subtotal, discount, taxRate, tax, total, status,
      status === 'paid' ? issued : null, str(b.payment_mode, 30) || null, str(b.notes, 500) || null);
      return tx.get('SELECT * FROM invoices WHERE id = ?', res.lastInsertRowid);
    });
    await D.notify(customer.id, { kind: 'invoice', key: `invoice:${inv.id}`, link: `#/invoice/${inv.id}`,
      title: `Invoice ${inv.invoice_no}`, body: `Your invoice for ${vehicle ? vehicle.make + ' ' + vehicle.model : 'recent work'} is ready to view.` });
    return { invoice: await D.invoiceView(inv) };
  });

  r.patch('/api/admin/invoices/:id', staff, async (ctx) => {
    const inv = await db.get('SELECT * FROM invoices WHERE id = ?', Number(ctx.params.id));
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const status = ctx.body.status === 'due' ? 'due' : 'paid';
    await db.run('UPDATE invoices SET status = ?, paid_on = ?, payment_mode = COALESCE(?, payment_mode) WHERE id = ?',
      status, status === 'paid' ? (inv.paid_on || today()) : null, str(ctx.body.payment_mode, 30) || null, inv.id);
    return { ok: true };
  });

  // ---- brands ----
  r.get('/api/admin/brands', staff, async () => ({ brands: await db.all('SELECT * FROM brands ORDER BY name') }));
  r.post('/api/admin/brands', staff, async (ctx) => {
    const name = str(ctx.body.name, 40);
    if (!name) throw bad('Brand name required');
    const ceramic = ctx.body.ceramic ? 1 : 0; const ppf = ctx.body.ppf ? 1 : 0;
    if (!ceramic && !ppf) throw bad('Tick ceramic, PPF or both');
    await db.run('INSERT INTO brands (name, ceramic, ppf) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET ceramic = excluded.ceramic, ppf = excluded.ppf', name, ceramic, ppf);
    return { brands: await db.all('SELECT * FROM brands ORDER BY name') };
  });

  // ---- warranties ----
  r.post('/api/admin/warranties', staff, async (ctx) => {
    const b = ctx.body;
    const customer = await getCustomer(b.customer_id);
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ? AND customer_id = ?', Number(b.vehicle_id), customer.id);
    if (!vehicle) throw bad('Choose the vehicle');
    const kind = b.kind === 'ppf' ? 'ppf' : 'ceramic';
    const brand = await db.get(`SELECT * FROM brands WHERE name = ? AND ${kind} = 1`, str(b.brand, 40));
    if (!brand) throw bad(`Choose a ${kind === 'ppf' ? 'PPF' : 'ceramic'} brand`);
    const product = str(b.product, 80);
    if (!product) throw bad('Product / package is required');
    const starts = isDate(b.starts_on) ? b.starts_on : today();
    const years = Number(b.years);
    if (!(years > 0 && years <= 12)) throw bad('Warranty length must be 1–12 years');
    const interval = Math.round(Number(b.interval_months) || (kind === 'ppf' ? 12 : 6));
    if (interval < 1 || interval > 24) throw bad('Service interval must be 1–24 months');
    const ends = addDays(addMonths(starts, Math.round(years * 12)), -1);
    const invoice = b.invoice_id ? await db.get('SELECT id FROM invoices WHERE id = ? AND customer_id = ?', Number(b.invoice_id), customer.id) : null;
    const terms = str(b.terms, 2000) || (kind === 'ppf'
      ? 'Covers yellowing, cracking, bubbling and delamination of the film under normal use. Excludes damage from accidents, stone chips that penetrate the film, improper washing and third-party repairs. Annual inspection at D24 Studio keeps this warranty valid.'
      : 'Covers loss of gloss and hydrophobic performance of the coating under normal use. Excludes damage from accidents, scratches, chemical misuse and automatic car washes. Periodic inspection and maintenance at D24 Studio keeps this warranty valid.');

    const w = await db.tx(async (tx) => {
      const cert = await D.nextCertNo(tx, kind, starts);
      const res = await tx.run(`INSERT INTO warranties (cert_no, customer_id, vehicle_id, invoice_id, kind, brand, product, coverage, starts_on, ends_on, interval_months, terms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cert, customer.id, vehicle.id, invoice?.id ?? null, kind, brand.name, product, str(b.coverage, 200) || null, starts, ends, interval, terms);
      const row = await tx.get('SELECT * FROM warranties WHERE id = ?', res.lastInsertRowid);
      await D.generateSchedule(tx, row);
      return row;
    });
    await D.notify(customer.id, { kind: 'warranty', key: `warranty-new:${w.id}`, link: `#/warranty/${w.id}`,
      title: `${kind === 'ppf' ? 'PPF' : 'Ceramic coating'} warranty issued`,
      body: `${brand.name} ${product} on your ${vehicle.make} ${vehicle.model}, valid until ${fmtDate(ends)}.` });
    return { warranty: await D.warrantyView(w) };
  });

  // ---- service schedule ----
  r.post('/api/admin/services', staff, async (ctx) => {
    const b = ctx.body;
    const customer = await getCustomer(b.customer_id);
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ? AND customer_id = ?', Number(b.vehicle_id), customer.id);
    if (!vehicle) throw bad('Choose the vehicle');
    const title = str(b.title, 80);
    if (!title) throw bad('Service title required');
    if (!isDate(b.due_on)) throw bad('Choose a due date');
    await db.run('INSERT INTO services (customer_id, vehicle_id, title, due_on) VALUES (?, ?, ?, ?)', customer.id, vehicle.id, title, b.due_on);
    return { ok: true };
  });

  r.post('/api/admin/services/:id/status', staff, async (ctx) => {
    const s = await db.get('SELECT * FROM services WHERE id = ?', Number(ctx.params.id));
    if (!s) throw new HttpError(404, 'Service not found');
    const status = ctx.body.status;
    if (!['due', 'done', 'skipped'].includes(status)) throw bad('Invalid status');
    await db.run('UPDATE services SET status = ?, done_on = ? WHERE id = ?', status, status === 'done' ? (isDate(ctx.body.done_on) ? ctx.body.done_on : today()) : null, s.id);
    return { ok: true };
  });

  // ---- bookings ----
  r.get('/api/admin/bookings', staff, async (ctx) => {
    const status = ctx.query.status;
    const rows = ['requested', 'confirmed', 'completed', 'cancelled'].includes(status)
      ? await db.all('SELECT * FROM bookings WHERE status = ? ORDER BY date DESC, slot LIMIT 200', status)
      : await db.all('SELECT * FROM bookings ORDER BY date DESC, slot LIMIT 200');
    return { bookings: await D.mapAll(rows, bookingRow) };
  });

  r.post('/api/admin/bookings/:id/status', staff, async (ctx) => {
    const b = await db.get('SELECT * FROM bookings WHERE id = ?', Number(ctx.params.id));
    if (!b) throw new HttpError(404, 'Booking not found');
    const status = ctx.body.status;
    const allowed = { requested: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [] };
    if (!allowed[b.status].includes(status)) throw bad(`Can’t change a ${b.status} booking to ${status}`);
    await db.tx(async (tx) => {
      await tx.run(`UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?`, status, b.id);
      if (b.service_id && status === 'completed') await tx.run(`UPDATE services SET status = 'done', done_on = ? WHERE id = ?`, b.date, b.service_id);
      if (b.service_id && status === 'cancelled') await tx.run(`UPDATE services SET status = 'due', booking_id = NULL WHERE id = ? AND status = 'booked'`, b.service_id);
    });
    const when = `${fmtDate(b.date)} at ${b.slot}`;
    if (status === 'confirmed') await D.notify(b.customer_id, { kind: 'booking', key: `booking-ok:${b.id}`, link: '#/book',
      title: 'Booking confirmed', body: `${b.service} on ${when}. See you at the studio.`,
      textSms: `D24 Studio: your ${b.service} is confirmed for ${when}. Pandeshwar, Mangaluru. Call ${config.studio.phone} to reschedule.` });
    if (status === 'cancelled') await D.notify(b.customer_id, { kind: 'booking', key: `booking-x:${b.id}`, link: '#/book',
      title: 'Booking cancelled', body: `${b.service} on ${when} was cancelled by the studio. Please pick another slot or call us.` });
    if (status === 'completed') await D.notify(b.customer_id, { kind: 'booking', key: `booking-done:${b.id}`, link: '#/',
      title: 'Thank you for visiting', body: `${b.service} is complete. Your records have been updated.` });
    return { ok: true };
  });
};
