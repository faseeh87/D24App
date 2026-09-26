'use strict';
// Staff API. Two roles:
//   Admin        – customers, vehicles, invoices (no discount without approval), payments,
//                  bookings, completing jobs (stock deduction), receiving stock
//   Super Admin  – everything above, plus: change customer mobile numbers, issue warranties,
//                  approve discounts, revenue, expenses & forecast, inventory setup,
//                  staff accounts, marketing alerts
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const D = require('./domain');
const B = require('./billing');
const INV = require('./inventory');
const FIN = require('./finance');
const SOCIAL = require('./social');
const { audienceFor, staffNotify } = require('./staff-notify');
const { cleanVehicle } = require('./routes-customer');
const { today, addDays, isDate, normalisePhone, str, fmtDate, bad, HttpError } = require('./util');

async function getCustomer(id) {
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', Number(id));
  if (!customer) throw new HttpError(404, 'Customer not found');
  return customer;
}

const invoiceRow = async (i) => ({ ...(await D.invoiceView(i)), payment_status: B.paymentStatus(i) });

async function customerBundle(id) {
  const customer = await getCustomer(id);
  const [vehicles, inv, war, svc, bk, disc] = await Promise.all([
    db.all('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id', customer.id),
    db.all('SELECT * FROM invoices WHERE customer_id = ? ORDER BY issued_on DESC, id DESC', customer.id),
    db.all('SELECT * FROM warranties WHERE customer_id = ? ORDER BY starts_on DESC', customer.id),
    db.all(`SELECT s.*, v.make, v.model, v.reg_no FROM services s JOIN vehicles v ON v.id = s.vehicle_id
            WHERE s.customer_id = ? ORDER BY s.due_on`, customer.id),
    db.all('SELECT * FROM bookings WHERE customer_id = ? ORDER BY date DESC', customer.id),
    db.all('SELECT * FROM discount_requests WHERE customer_id = ? ORDER BY id DESC', customer.id),
  ]);
  const warrantiesByInvoice = {};
  for (const w of war) if (w.invoice_id != null) (warrantiesByInvoice[w.invoice_id] ||= []).push(w.invoice_line);
  const invoices = await D.mapAll(inv, async (i) => {
    const row = await invoiceRow(i);
    // Warranty lines still waiting (discounted invoices need the Super Admin; unpaid ones wait for payment)
    row.pending_warranties = row.items.map((it, n) => ({ ...it, line: n }))
      .filter((it) => it.warranty && !(warrantiesByInvoice[i.id] || []).includes(it.line));
    return row;
  });
  return {
    customer, vehicles, invoices,
    warranties: await D.mapAll(war, D.warrantyView),
    services: svc.map(D.serviceView),
    bookings: await D.mapAll(bk, D.bookingView),
    discounts: disc,
  };
}

async function bookingRow(b) {
  const [view, c] = await Promise.all([D.bookingView(b), db.get('SELECT name, phone FROM customers WHERE id = ?', b.customer_id)]);
  return { ...view, customer_name: c?.name, customer_phone: c?.phone };
}

module.exports = function register(r) {
  const staff = auth.requireAdmin;
  const sup = auth.requireSuper;

  // ---------------------------------------------------------------- session
  r.post('/api/admin/login', auth.adminLogin);
  r.post('/api/admin/logout', async (ctx) => { await auth.destroySession(ctx, 'admin'); return { ok: true }; });
  r.get('/api/admin/session', staff, async (ctx) => ({
    ok: true, staff: ctx.staff, studio: config.studio, services: config.services, catalog: config.serviceCatalog, gstRate: config.gstRate,
    categories: INV.CATEGORIES,
    unread: (await db.get(`SELECT COUNT(*) AS n FROM staff_notifications WHERE read_at IS NULL AND audience IN (${audienceFor(ctx.staff.role).map(() => '?').join(',')})`, ...audienceFor(ctx.staff.role))).n,
  }));

  // ---------------------------------------------------------------- overview
  r.get('/api/admin/overview', staff, async (ctx) => {
    const t = today();
    const svc = async (where, ...p) => (await db.all(`SELECT s.*, v.make, v.model, v.reg_no, c.name AS customer_name, c.phone AS customer_phone
      FROM services s JOIN vehicles v ON v.id = s.vehicle_id JOIN customers c ON c.id = s.customer_id WHERE ${where} ORDER BY s.due_on`, ...p)).map(D.serviceView);
    const [customers, active, requests, schedule, missed, dueSoon, lowStock, unpaid, pendingDiscounts] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM customers'),
      db.get('SELECT COUNT(*) AS n FROM warranties WHERE ends_on >= ?', t),
      db.all(`SELECT * FROM bookings WHERE status = 'requested' ORDER BY date, slot`),
      db.all(`SELECT * FROM bookings WHERE status = 'confirmed' AND date BETWEEN ? AND ? ORDER BY date, slot`, t, addDays(t, 7)),
      svc(`s.status = 'due' AND s.due_on < ?`, t),
      svc(`s.status = 'due' AND s.due_on BETWEEN ? AND ?`, t, addDays(t, config.reminders.upcomingDays)),
      db.all('SELECT * FROM inventory_items WHERE active = 1 AND quantity <= reorder_level ORDER BY brand'),
      db.get('SELECT COUNT(*) AS n, COALESCE(SUM(total - amount_paid),0) AS amount FROM invoices WHERE amount_paid < total'),
      db.get(`SELECT COUNT(*) AS n FROM discount_requests WHERE status = 'pending'`),
    ]);
    const out = {
      today: t, role: ctx.staff.role,
      counts: { customers: customers.n, active_warranties: active.n, unpaid_invoices: unpaid.n, pending_discounts: pendingDiscounts.n },
      requests: await D.mapAll(requests, bookingRow),
      schedule: await D.mapAll(schedule, bookingRow),
      missed, due_soon: dueSoon, low_stock: lowStock,
    };
    if (ctx.staff.role === 'super') {
      const rev = await FIN.revenue();
      out.revenue = { day: rev.day, month: rev.month, outstanding: rev.outstanding };
    }
    return out;
  });

  // ---------------------------------------------------------------- notifications
  r.get('/api/admin/notifications', staff, async (ctx) => {
    const aud = audienceFor(ctx.staff.role);
    return { notifications: await db.all(`SELECT * FROM staff_notifications WHERE audience IN (${aud.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 100`, ...aud) };
  });
  r.post('/api/admin/notifications/read', staff, async (ctx) => {
    const aud = audienceFor(ctx.staff.role);
    await db.run(`UPDATE staff_notifications SET read_at = datetime('now') WHERE read_at IS NULL AND audience IN (${aud.map(() => '?').join(',')})`, ...aud);
    return { ok: true };
  });

  // ---------------------------------------------------------------- customers
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

  // Super Admin only: change a customer's mobile number (their sign-in). Signs them out everywhere.
  r.post('/api/admin/customers/:id/phone', sup, async (ctx) => {
    const c = await getCustomer(ctx.params.id);
    const phone = normalisePhone(ctx.body.phone);
    if (!phone) throw bad('Enter a valid 10-digit mobile number');
    if (phone === c.phone) throw bad('That is already this customer’s number');
    if (await db.get('SELECT 1 AS x FROM customers WHERE phone = ?', phone)) throw bad('Another customer already uses this number');
    await db.tx(async (tx) => {
      await tx.run('UPDATE customers SET phone = ? WHERE id = ?', phone, c.id);
      await tx.run(`DELETE FROM sessions WHERE role = 'customer' AND customer_id = ?`, c.id);
      await tx.run('DELETE FROM otps WHERE phone IN (?, ?)', c.phone, phone);
    });
    await D.notify(c.id, { kind: 'invoice', key: `phone-changed:${c.id}:${Date.now()}`, link: '#/account',
      title: 'Your mobile number was updated', body: `The studio changed your sign-in number to ${phone.replace('+91', '+91 ')}.` });
    return { ok: true, phone };
  });

  r.post('/api/admin/customers/:id/vehicles', staff, async (ctx) => {
    const cid = (await getCustomer(ctx.params.id)).id;
    const v = cleanVehicle(ctx.body);
    if (await db.get('SELECT 1 AS x FROM vehicles WHERE customer_id = ? AND reg_no = ?', cid, v.reg_no)) throw bad('Vehicle already exists for this customer');
    const res = await db.run('INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no, vin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      cid, v.kind, v.make, v.model, v.year, v.colour, v.reg_no, v.vin);
    return { vehicle: await db.get('SELECT * FROM vehicles WHERE id = ?', res.lastInsertRowid) };
  });

  // ---------------------------------------------------------------- discounts
  r.post('/api/admin/discounts', staff, async (ctx) => ({ request: await B.requestDiscount(ctx.body, ctx.staff) }));
  r.get('/api/admin/discounts', staff, async (ctx) => {
    const status = ['pending', 'approved', 'rejected', 'used'].includes(ctx.query.status) ? ctx.query.status : 'pending';
    const rows = await db.all(`SELECT d.*, c.name AS customer_name, c.phone AS customer_phone, s.name AS requested_by_name
      FROM discount_requests d JOIN customers c ON c.id = d.customer_id LEFT JOIN staff s ON s.id = d.requested_by
      WHERE d.status = ? ORDER BY d.id DESC LIMIT 100`, status);
    return { requests: rows };
  });
  r.post('/api/admin/discounts/:id/decide', sup, async (ctx) => B.decideDiscount(ctx.params.id, ctx.body, ctx.staff));

  // ---------------------------------------------------------------- invoices & payments
  r.post('/api/admin/invoices', staff, async (ctx) => ({ invoice: await invoiceRow(await B.createInvoice(ctx.body, ctx.staff)) }));

  r.post('/api/admin/invoices/:id/payments', staff, async (ctx) => {
    const issued = await B.recordPayment(Number(ctx.params.id), { amount: ctx.body.amount, mode: ctx.body.mode, paidOn: ctx.body.paid_on, staffId: ctx.staff.id });
    return { ok: true, warranties_issued: issued.length };
  });

  r.get('/api/admin/invoices/:id/payments', staff, async (ctx) => ({
    payments: await db.all(`SELECT p.*, s.name AS recorded_by_name FROM payments p LEFT JOIN staff s ON s.id = p.recorded_by WHERE invoice_id = ? ORDER BY p.id`, Number(ctx.params.id)),
  }));

  // ---------------------------------------------------------------- brands & warranties (Super Admin)
  r.get('/api/admin/brands', staff, async () => ({ brands: await db.all('SELECT * FROM brands ORDER BY name') }));
  r.post('/api/admin/brands', sup, async (ctx) => {
    const name = str(ctx.body.name, 40);
    if (!name) throw bad('Brand name required');
    const ceramic = ctx.body.ceramic ? 1 : 0; const ppf = ctx.body.ppf ? 1 : 0;
    if (!ceramic && !ppf) throw bad('Tick ceramic, PPF or both');
    await db.run('INSERT INTO brands (name, ceramic, ppf) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET ceramic = excluded.ceramic, ppf = excluded.ppf', name, ceramic, ppf);
    return { brands: await db.all('SELECT * FROM brands ORDER BY name') };
  });

  r.post('/api/admin/warranties', sup, async (ctx) => {
    const b = ctx.body;
    const customer = await getCustomer(b.customer_id);
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ? AND customer_id = ?', Number(b.vehicle_id), customer.id);
    if (!vehicle) throw bad('Choose the vehicle');
    const spec = await B.cleanWarrantySpec(b);
    const invoice = b.invoice_id ? await db.get('SELECT id FROM invoices WHERE id = ? AND customer_id = ?', Number(b.invoice_id), customer.id) : null;
    const line = invoice && b.invoice_line !== undefined && b.invoice_line !== '' ? Number(b.invoice_line) : null;
    if (invoice && line !== null && await db.get('SELECT id FROM warranties WHERE invoice_id = ? AND invoice_line = ?', invoice.id, line)) {
      throw bad('A warranty was already issued for that invoice line');
    }
    const w = await db.tx((tx) => B.issueWarranty(tx, { customerId: customer.id, vehicleId: vehicle.id, invoiceId: invoice?.id, spec, startsOn: b.starts_on, auto: false, staffId: ctx.staff.id, line }));
    await B.notifyWarranty(w, vehicle);
    return { warranty: await D.warrantyView(w) };
  });

  // ---------------------------------------------------------------- service schedule
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

  // ---------------------------------------------------------------- bookings
  r.get('/api/admin/bookings', staff, async (ctx) => {
    const status = ctx.query.status;
    const rows = ['requested', 'confirmed', 'completed', 'cancelled'].includes(status)
      ? await db.all('SELECT * FROM bookings WHERE status = ? ORDER BY date DESC, slot LIMIT 200', status)
      : await db.all('SELECT * FROM bookings ORDER BY date DESC, slot LIMIT 200');
    return { bookings: await D.mapAll(rows, bookingRow) };
  });

  // What completing this booking will take out of stock (staff pick the item per category).
  r.get('/api/admin/bookings/:id/usage', staff, async (ctx) => {
    const b = await db.get('SELECT b.*, v.kind FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = ?', Number(ctx.params.id));
    if (!b) throw new HttpError(404, 'Booking not found');
    return { usage: await INV.plannedUsage(b, b.kind) };
  });

  r.post('/api/admin/bookings/:id/status', staff, async (ctx) => {
    const b = await db.get('SELECT b.*, v.kind FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = ?', Number(ctx.params.id));
    if (!b) throw new HttpError(404, 'Booking not found');
    const status = ctx.body.status;
    const allowed = { requested: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'], completed: [], cancelled: [] };
    if (!allowed[b.status].includes(status)) throw bad(`Can’t change a ${b.status} booking to ${status}`);
    await db.tx(async (tx) => {
      await tx.run(`UPDATE bookings SET status = ?, updated_at = datetime('now'), completed_by = ? WHERE id = ?`, status, status === 'completed' ? ctx.staff.id : null, b.id);
      if (status === 'completed') {
        await INV.deductForBooking(tx, b, b.kind, ctx.body.picks || {}, ctx.staff.id);
        if (b.service_id) await tx.run(`UPDATE services SET status = 'done', done_on = ? WHERE id = ?`, b.date, b.service_id);
      }
      if (b.service_id && status === 'cancelled') await tx.run(`UPDATE services SET status = 'due', booking_id = NULL WHERE id = ? AND status = 'booked'`, b.service_id);
    });
    if (status === 'completed') await INV.checkStockAlerts();
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

  // ---------------------------------------------------------------- inventory
  r.get('/api/admin/inventory', staff, async () => {
    const [items, standards, moves, car, bike] = await Promise.all([
      db.all('SELECT * FROM inventory_items WHERE active = 1 ORDER BY category, brand, sub_brand'),
      db.all('SELECT * FROM usage_standards ORDER BY kind, service, category'),
      db.all(`SELECT m.*, i.brand, i.sub_brand, i.unit, s.name AS staff_name FROM inventory_moves m JOIN inventory_items i ON i.id = m.item_id
              LEFT JOIN staff s ON s.id = m.staff_id ORDER BY m.id DESC LIMIT 40`),
      INV.availability('car'), INV.availability('bike'),
    ]);
    const paused = [...Object.entries(car).filter(([, a]) => !a.available).map(([s, a]) => ({ service: s, kind: 'car', reason: a.reason })),
      ...Object.entries(bike).filter(([, a]) => !a.available).map(([s, a]) => ({ service: s, kind: 'bike', reason: a.reason }))];
    return { items, standards, moves, paused, categories: INV.CATEGORIES };
  });

  const cleanItem = (b) => {
    const category = INV.CATEGORIES.find((c) => c.name === b.category);
    if (!category) throw bad('Choose a category');
    const item = {
      category: category.name, unit: category.unit,
      brand: str(b.brand, 40), sub_brand: str(b.sub_brand, 80),
      pack_size: b.pack_size === '' || b.pack_size == null ? null : Number(b.pack_size),
      reorder_level: Number(b.reorder_level) || 0,
      unit_cost: b.unit_cost === '' || b.unit_cost == null ? null : Number(b.unit_cost),
    };
    if (!item.brand || !item.sub_brand) throw bad('Brand and sub-brand / product are required');
    if (item.pack_size !== null && !(item.pack_size > 0)) throw bad('Pack size must be a positive number');
    if (item.reorder_level < 0) throw bad('Reorder level can’t be negative');
    return item;
  };

  r.post('/api/admin/inventory/items', sup, async (ctx) => {
    const it = cleanItem(ctx.body);
    const qty = Math.max(0, Number(ctx.body.quantity) || 0);
    const res = await db.run(`INSERT INTO inventory_items (category, brand, sub_brand, unit, pack_size, quantity, reorder_level, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      it.category, it.brand, it.sub_brand, it.unit, it.pack_size, qty, it.reorder_level, it.unit_cost);
    if (qty) await db.run(`INSERT INTO inventory_moves (item_id, delta, reason, staff_id) VALUES (?, ?, 'opening stock', ?)`, res.lastInsertRowid, qty, ctx.staff.id);
    await INV.checkStockAlerts();
    return { ok: true };
  });

  r.patch('/api/admin/inventory/items/:id', sup, async (ctx) => {
    const cur = await db.get('SELECT * FROM inventory_items WHERE id = ?', Number(ctx.params.id));
    if (!cur) throw new HttpError(404, 'Item not found');
    if (ctx.body.active === false) { await db.run('UPDATE inventory_items SET active = 0 WHERE id = ?', cur.id); return { ok: true }; }
    const it = cleanItem(ctx.body);
    await db.run('UPDATE inventory_items SET category = ?, brand = ?, sub_brand = ?, unit = ?, pack_size = ?, reorder_level = ?, unit_cost = ? WHERE id = ?',
      it.category, it.brand, it.sub_brand, it.unit, it.pack_size, it.reorder_level, it.unit_cost, cur.id);
    await INV.checkStockAlerts();
    return { ok: true };
  });

  // Stock received (Admin or Super Admin) or corrected after a count (Super Admin).
  r.post('/api/admin/inventory/items/:id/stock', staff, async (ctx) => {
    const cur = await db.get('SELECT * FROM inventory_items WHERE id = ? AND active = 1', Number(ctx.params.id));
    if (!cur) throw new HttpError(404, 'Item not found');
    const mode = ctx.body.mode === 'count' ? 'count' : 'received';
    const qty = Number(ctx.body.quantity);
    if (!(qty >= 0) || (mode === 'received' && !(qty > 0))) throw bad('Enter a quantity');
    if (mode === 'count' && ctx.staff.role !== 'super') throw new HttpError(403, 'Only the Super Admin can correct stock counts');
    const delta = mode === 'received' ? qty : qty - cur.quantity;
    const cost = mode === 'received' && Number(ctx.body.cost) > 0 ? Math.round(Number(ctx.body.cost) * 100) : null;
    await db.tx(async (tx) => {
      await tx.run('UPDATE inventory_items SET quantity = quantity + ?, restock_seq = restock_seq + ? WHERE id = ?', delta, delta > 0 ? 1 : 0, cur.id);
      await tx.run('INSERT INTO inventory_moves (item_id, delta, reason, cost, staff_id) VALUES (?, ?, ?, ?, ?)', cur.id, delta, mode === 'received' ? 'received' : 'stock count', cost, ctx.staff.id);
      // A purchase with a cost is also recorded as an inventory expense
      if (cost) await tx.run(`INSERT INTO expenses (spent_on, category, amount, note, created_by) VALUES (?, 'inventory', ?, ?, ?)`,
        today(), cost, `${cur.brand} ${cur.sub_brand}: ${qty} ${cur.unit}`, ctx.staff.id);
    });
    await INV.checkStockAlerts();
    return { ok: true };
  });

  r.post('/api/admin/inventory/standards', sup, async (ctx) => {
    const b = ctx.body;
    const kind = b.kind === 'bike' ? 'bike' : 'car';
    if (!config.servicesFor(kind).includes(b.service)) throw bad('Choose a service offered for this vehicle type');
    if (!INV.CATEGORIES.some((c) => c.name === b.category)) throw bad('Choose a category');
    const amount = Number(b.amount);
    if (amount === 0 || b.remove) { await db.run('DELETE FROM usage_standards WHERE service = ? AND kind = ? AND category = ?', b.service, kind, b.category); return { ok: true }; }
    if (!(amount > 0)) throw bad('Enter the amount used per vehicle');
    await db.run('INSERT INTO usage_standards (service, kind, category, amount) VALUES (?, ?, ?, ?) ON CONFLICT(service, kind, category) DO UPDATE SET amount = excluded.amount',
      b.service, kind, b.category, amount);
    return { ok: true };
  });

  // ---------------------------------------------------------------- finance (Super Admin)
  r.get('/api/admin/finance', sup, async () => {
    const [rev, fc, recent] = await Promise.all([
      FIN.revenue(), FIN.forecast(),
      db.all('SELECT e.*, s.name AS created_by_name FROM expenses e LEFT JOIN staff s ON s.id = e.created_by ORDER BY spent_on DESC, id DESC LIMIT 50'),
    ]);
    return { revenue: rev, forecast: fc, expenses: recent, categories: FIN.EXPENSE_CATEGORIES };
  });
  r.post('/api/admin/expenses', sup, async (ctx) => {
    const b = ctx.body;
    if (!FIN.EXPENSE_CATEGORIES.includes(b.category)) throw bad('Choose rent, inventory, salary or maintenance');
    const amount = Math.round(Number(b.amount) * 100);
    if (!(amount > 0)) throw bad('Enter the amount in ₹');
    await db.run('INSERT INTO expenses (spent_on, category, amount, note, created_by) VALUES (?, ?, ?, ?, ?)',
      isDate(b.spent_on) ? b.spent_on : today(), b.category, amount, str(b.note, 200) || null, ctx.staff.id);
    return { ok: true };
  });
  r.delete('/api/admin/expenses/:id', sup, async (ctx) => { await db.run('DELETE FROM expenses WHERE id = ?', Number(ctx.params.id)); return { ok: true }; });

  // ---------------------------------------------------------------- staff accounts (Super Admin)
  r.get('/api/admin/staff', sup, async () => ({ staff: await db.all('SELECT id, name, role, builtin, active, created_at FROM staff ORDER BY builtin DESC, active DESC, name') }));
  r.post('/api/admin/staff', sup, async (ctx) => {
    const name = str(ctx.body.name, 60);
    const pin = String(ctx.body.pin || '');
    const role = ctx.body.role === 'super' ? 'super' : 'admin';
    if (!name) throw bad('Enter the staff member’s name');
    if (!/^\d{6,10}$/.test(pin)) throw bad('PIN must be 6–10 digits');
    if (await auth.pinTaken(pin)) throw bad('That PIN is already in use. Choose another.');
    await db.run('INSERT INTO staff (name, role, pin_hash) VALUES (?, ?, ?)', name, role, auth.hashPin(pin));
    return { ok: true };
  });
  r.patch('/api/admin/staff/:id', sup, async (ctx) => {
    const s = await db.get('SELECT * FROM staff WHERE id = ?', Number(ctx.params.id));
    if (!s) throw new HttpError(404, 'Staff not found');
    if (s.builtin) throw bad('The owner account is managed with the SUPER_ADMIN_PIN setting in Vercel');
    if (ctx.body.pin) {
      const pin = String(ctx.body.pin);
      if (!/^\d{6,10}$/.test(pin)) throw bad('PIN must be 6–10 digits');
      if (await auth.pinTaken(pin, s.id)) throw bad('That PIN is already in use. Choose another.');
      await db.run('UPDATE staff SET pin_hash = ? WHERE id = ?', auth.hashPin(pin), s.id);
    }
    if (ctx.body.active !== undefined) {
      await db.run('UPDATE staff SET active = ? WHERE id = ?', ctx.body.active ? 1 : 0, s.id);
      if (!ctx.body.active) await db.run(`DELETE FROM sessions WHERE role = 'admin' AND staff_id = ?`, s.id);
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- marketing (Super Admin)
  r.get('/api/admin/marketing', sup, async () => SOCIAL.status());
  r.post('/api/admin/marketing/settings', sup, async (ctx) => {
    const b = ctx.body;
    for (const k of ['ig_token', 'ig_user_id', 'yt_api_key', 'yt_channel']) {
      if (b[k] !== undefined) await SOCIAL.setSetting(k, str(b[k], 600));
    }
    if (b.ig_token) await SOCIAL.setSetting('ig_token_refreshed', null);
    return { ok: true };
  });
  r.post('/api/admin/marketing/check', sup, async () => ({ result: await SOCIAL.check() }));
};

module.exports.staffNotify = staffNotify;
