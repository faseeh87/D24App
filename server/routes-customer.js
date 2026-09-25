'use strict';
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const D = require('./domain');
const { today, addDays, isDate, weekday, str, bad, HttpError } = require('./util');

const REG_RE = /^[A-Z0-9 -]{4,15}$/;

function cleanVehicle(b) {
  const v = {
    kind: b.kind === 'bike' ? 'bike' : 'car',
    make: str(b.make, 40),
    model: str(b.model, 60),
    year: b.year ? Number(b.year) : null,
    colour: str(b.colour, 30) || null,
    reg_no: str(b.reg_no, 15).toUpperCase().replace(/\s+/g, ' '),
    vin: str(b.vin, 20).toUpperCase() || null,
  };
  if (!v.make || !v.model) throw bad('Make and model are required');
  if (!REG_RE.test(v.reg_no)) throw bad('Enter a valid registration number, e.g. KA 19 MN 2424');
  const y = new Date().getFullYear() + 1;
  if (v.year !== null && (!Number.isInteger(v.year) || v.year < 1950 || v.year > y)) throw bad('Enter a valid year');
  return v;
}

function own(table, id, customerId) {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ? AND customer_id = ?`, Number(id), customerId);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

module.exports = function register(r) {
  const me = auth.requireCustomer;

  r.get('/api/studio', () => ({ studio: config.studio, services: config.services, slots: config.booking.slots }));

  // ---- auth ----
  r.post('/api/auth/otp', auth.requestOtp);
  r.post('/api/auth/verify', auth.verifyOtp);
  r.post('/api/auth/logout', (ctx) => { auth.destroySession(ctx, 'customer'); return { ok: true }; });

  // ---- profile ----
  r.get('/api/me', me, (ctx) => ({ customer: ctx.customer }));
  r.patch('/api/me', me, (ctx) => {
    const name = str(ctx.body.name, 80);
    const email = str(ctx.body.email, 120);
    const city = str(ctx.body.city, 60);
    if (!name) throw bad('Please enter your name');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
    db.run('UPDATE customers SET name = ?, email = ?, city = ? WHERE id = ?', name, email || null, city || null, ctx.customer.id);
    return { customer: db.get('SELECT * FROM customers WHERE id = ?', ctx.customer.id) };
  });

  // ---- dashboard ----
  r.get('/api/dashboard', me, (ctx) => {
    const id = ctx.customer.id;
    D.runReminders(id);
    const services = db.all(`SELECT * FROM services WHERE customer_id = ? AND status IN ('due','booked') ORDER BY due_on`, id).map(D.serviceView);
    const decorate = (s) => ({ ...s, vehicle: db.get('SELECT * FROM vehicles WHERE id = ?', s.vehicle_id) });
    return {
      customer: ctx.customer,
      vehicles: db.all('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id', id),
      missed: services.filter((s) => s.state === 'missed').map(decorate),
      upcoming: services.filter((s) => s.state === 'upcoming' || s.status === 'booked').map(decorate),
      next_service: services.find((s) => s.state !== 'missed') ? decorate(services.find((s) => s.state !== 'missed')) : null,
      warranties: db.all('SELECT * FROM warranties WHERE customer_id = ? ORDER BY starts_on DESC', id).map(D.warrantyView),
      latest_invoice: (() => { const i = db.get('SELECT * FROM invoices WHERE customer_id = ? ORDER BY issued_on DESC, id DESC LIMIT 1', id); return i ? D.invoiceView(i) : null; })(),
      bookings: db.all(`SELECT * FROM bookings WHERE customer_id = ? AND status IN ('requested','confirmed') AND date >= ? ORDER BY date, slot`, id, today()).map(D.bookingView),
      unread: db.get('SELECT COUNT(*) AS n FROM notifications WHERE customer_id = ? AND read_at IS NULL', id).n,
    };
  });

  // ---- vehicles ----
  r.get('/api/vehicles', me, (ctx) => ({ vehicles: db.all('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id', ctx.customer.id) }));
  r.post('/api/vehicles', me, (ctx) => {
    const v = cleanVehicle(ctx.body);
    if (db.get('SELECT 1 FROM vehicles WHERE customer_id = ? AND reg_no = ?', ctx.customer.id, v.reg_no)) throw bad('This vehicle is already in your garage');
    const res = db.run('INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no, vin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ctx.customer.id, v.kind, v.make, v.model, v.year, v.colour, v.reg_no, v.vin);
    return { vehicle: db.get('SELECT * FROM vehicles WHERE id = ?', res.lastInsertRowid) };
  });
  r.patch('/api/vehicles/:id', me, (ctx) => {
    const cur = own('vehicles', ctx.params.id, ctx.customer.id);
    const v = cleanVehicle(ctx.body);
    if (db.get('SELECT 1 FROM vehicles WHERE customer_id = ? AND reg_no = ? AND id != ?', ctx.customer.id, v.reg_no, cur.id)) throw bad('Another vehicle has this registration');
    db.run('UPDATE vehicles SET kind=?, make=?, model=?, year=?, colour=?, reg_no=?, vin=? WHERE id = ?', v.kind, v.make, v.model, v.year, v.colour, v.reg_no, v.vin, cur.id);
    return { vehicle: db.get('SELECT * FROM vehicles WHERE id = ?', cur.id) };
  });
  r.delete('/api/vehicles/:id', me, (ctx) => {
    const cur = own('vehicles', ctx.params.id, ctx.customer.id);
    const linked = db.get(`SELECT (SELECT COUNT(*) FROM invoices WHERE vehicle_id = ?) + (SELECT COUNT(*) FROM warranties WHERE vehicle_id = ?)
                           + (SELECT COUNT(*) FROM bookings WHERE vehicle_id = ?) AS n`, cur.id, cur.id, cur.id).n;
    if (linked) throw bad('This vehicle has studio records (invoices, warranties or bookings), so it can’t be removed. Contact the studio for help.');
    db.run('DELETE FROM vehicles WHERE id = ?', cur.id);
    return { ok: true };
  });

  // ---- invoices ----
  r.get('/api/invoices', me, (ctx) => ({
    invoices: db.all('SELECT * FROM invoices WHERE customer_id = ? ORDER BY issued_on DESC, id DESC', ctx.customer.id).map(D.invoiceView),
  }));
  r.get('/api/invoices/:id', me, (ctx) => {
    const inv = D.invoiceView(own('invoices', ctx.params.id, ctx.customer.id));
    return { invoice: inv, customer: ctx.customer, studio: config.studio,
      warranties: db.all('SELECT id, kind, brand, product, cert_no FROM warranties WHERE invoice_id = ?', inv.id) };
  });

  // ---- warranties ----
  r.get('/api/warranties', me, (ctx) => ({
    warranties: db.all('SELECT * FROM warranties WHERE customer_id = ? ORDER BY starts_on DESC', ctx.customer.id).map(D.warrantyView),
  }));
  r.get('/api/warranties/:id', me, (ctx) => {
    const w = D.warrantyView(own('warranties', ctx.params.id, ctx.customer.id));
    const invoice = w.invoice_id ? db.get('SELECT id, invoice_no FROM invoices WHERE id = ?', w.invoice_id) : null;
    return { warranty: w, invoice, customer: ctx.customer, studio: config.studio };
  });

  // ---- service schedule ----
  r.get('/api/services', me, (ctx) => ({
    services: db.all(`SELECT s.*, v.make, v.model, v.reg_no FROM services s JOIN vehicles v ON v.id = s.vehicle_id
                      WHERE s.customer_id = ? AND s.status IN ('due','booked') ORDER BY s.due_on`, ctx.customer.id).map(D.serviceView),
  }));

  // ---- bookings ----
  r.get('/api/slots', me, (ctx) => {
    const date = ctx.query.date;
    if (!isDate(date)) throw bad('Invalid date');
    const closed = weekday(date) === 0;
    return { date, closed, slots: closed ? [] : D.slotAvailability(date) };
  });

  r.get('/api/bookings', me, (ctx) => ({
    bookings: db.all('SELECT * FROM bookings WHERE customer_id = ? ORDER BY date DESC, slot DESC', ctx.customer.id).map(D.bookingView),
  }));

  r.post('/api/bookings', me, (ctx) => {
    const b = ctx.body;
    const cid = ctx.customer.id;
    const vehicle = own('vehicles', b.vehicle_id, cid);
    const service = str(b.service, 80);
    if (!config.services.includes(service)) throw bad('Choose a service');
    const date = b.date;
    const t = today();
    if (!isDate(date) || date < t || date > addDays(t, config.booking.maxDaysAhead)) throw bad('Choose a date within the next 90 days');
    if (weekday(date) === 0) throw bad('We’re open on Sundays by appointment only. Please call the studio.');
    if (!config.booking.slots.includes(b.slot)) throw bad('Choose a time slot');
    let linked = null;
    if (b.service_id) {
      linked = own('services', b.service_id, cid);
      if (linked.status !== 'due') throw bad('This service is already booked or completed');
      if (linked.vehicle_id !== vehicle.id) throw bad('That service belongs to a different vehicle');
    }
    const notes = str(b.notes, 500) || null;

    const booking = db.tx(() => {
      const slot = D.slotAvailability(date).find((s) => s.slot === b.slot);
      if (!slot || !slot.available) throw new HttpError(409, 'That slot has just filled up. Please pick another time.');
      const res = db.run('INSERT INTO bookings (customer_id, vehicle_id, service_id, service, date, slot, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        cid, vehicle.id, linked?.id ?? null, service, date, b.slot, notes);
      if (linked) db.run(`UPDATE services SET status = 'booked', booking_id = ? WHERE id = ?`, res.lastInsertRowid, linked.id);
      return db.get('SELECT * FROM bookings WHERE id = ?', res.lastInsertRowid);
    });
    D.notify(cid, {
      kind: 'booking', key: `booking-req:${booking.id}`, link: '#/book',
      title: 'Booking request received',
      body: `${service} for your ${vehicle.make} ${vehicle.model} on ${require('./util').fmtDate(date)} at ${b.slot}. We’ll confirm shortly.`,
    });
    return { booking: D.bookingView(booking) };
  });

  r.post('/api/bookings/:id/cancel', me, (ctx) => {
    const b = own('bookings', ctx.params.id, ctx.customer.id);
    if (!['requested', 'confirmed'].includes(b.status)) throw bad('This booking can no longer be cancelled');
    db.tx(() => {
      db.run(`UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`, b.id);
      if (b.service_id) db.run(`UPDATE services SET status = 'due', booking_id = NULL WHERE id = ? AND status = 'booked'`, b.service_id);
    });
    return { ok: true };
  });

  // ---- notifications ----
  r.get('/api/notifications', me, (ctx) => {
    D.runReminders(ctx.customer.id);
    return { notifications: db.all('SELECT * FROM notifications WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', ctx.customer.id) };
  });
  r.post('/api/notifications/read', me, (ctx) => {
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.map(Number).filter(Number.isInteger) : null;
    if (ids && ids.length) {
      db.run(`UPDATE notifications SET read_at = datetime('now') WHERE customer_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, ctx.customer.id, ...ids);
    } else {
      db.run(`UPDATE notifications SET read_at = datetime('now') WHERE customer_id = ? AND read_at IS NULL`, ctx.customer.id);
    }
    return { ok: true };
  });
};

module.exports.cleanVehicle = cleanVehicle;
