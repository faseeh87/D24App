'use strict';
// Seeds a demo customer (mobile 98765 43210) with vehicles, invoices, warranties
// and a service history whose dates are relative to today, so the demo always
// shows one missed and one upcoming service.   Usage: npm run seed [-- --reset]
const fs = require('node:fs');
const config = require('./config');
if (process.argv.includes('--reset')) for (const f of [config.dbPath, config.dbPath + '-wal', config.dbPath + '-shm']) fs.rmSync(f, { force: true });

const db = require('./db');
const D = require('./domain');
const { today, addDays, addMonths } = require('./util');

const PHONE = '+919876543210';
if (db.get('SELECT 1 FROM customers WHERE phone = ?', PHONE)) {
  console.log('Demo customer already exists. Use `npm run seed -- --reset` to start fresh.');
  process.exit(0);
}

const t = today();
const cid = db.run('INSERT INTO customers (phone, name, email, city) VALUES (?, ?, ?, ?)', PHONE, 'Rahul Kamath', 'rahul@example.com', 'Mangaluru').lastInsertRowid;
const car = db.run(`INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no) VALUES (?, 'car', 'BMW', '330i M Sport', 2023, 'Mineral White', 'KA 19 MN 2424')`, cid).lastInsertRowid;
const bike = db.run(`INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no) VALUES (?, 'bike', 'Royal Enfield', 'Interceptor 650', 2022, 'Black Ray', 'KA 19 EQ 0650')`, cid).lastInsertRowid;

function invoice(vehicleId, issued, items, mode) {
  const list = items.map(([desc, qty, rupees]) => ({ desc, qty, rate: rupees * 100 }));
  const subtotal = list.reduce((s, i) => s + i.qty * i.rate, 0);
  const tax = Math.round(subtotal * config.gstRate / 100);
  const no = D.nextInvoiceNo(issued);
  return db.run(`INSERT INTO invoices (invoice_no, customer_id, vehicle_id, issued_on, items, subtotal, discount, tax_rate, tax, total, status, paid_on, payment_mode)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'paid', ?, ?)`, no, cid, vehicleId, issued, JSON.stringify(list), subtotal, config.gstRate, tax, subtotal + tax, issued, mode).lastInsertRowid;
}

function warranty(vehicleId, invoiceId, kind, brand, product, coverage, starts, years, interval) {
  const ends = addDays(addMonths(starts, years * 12), -1);
  const cert = D.nextCertNo(kind, starts);
  const terms = kind === 'ppf'
    ? 'Covers yellowing, cracking, bubbling and delamination of the film under normal use. Excludes damage from accidents, stone chips that penetrate the film, improper washing and third-party repairs. Annual inspection at D24 Studio keeps this warranty valid.'
    : 'Covers loss of gloss and hydrophobic performance of the coating under normal use. Excludes damage from accidents, scratches, chemical misuse and automatic car washes. Periodic inspection and maintenance at D24 Studio keeps this warranty valid.';
  const id = db.run(`INSERT INTO warranties (cert_no, customer_id, vehicle_id, invoice_id, kind, brand, product, coverage, starts_on, ends_on, interval_months, terms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, cert, cid, vehicleId, invoiceId, kind, brand, product, coverage, starts, ends, interval, terms).lastInsertRowid;
  D.generateSchedule(db.get('SELECT * FROM warranties WHERE id = ?', id));
  return id;
}

// Car: ceramic coating 18 months ago (third check-up missed 12 days ago)
const ccStart = addDays(addMonths(t, -18), -12);
const inv1 = invoice(car, ccStart, [
  ['Paint correction, two-stage machine polish', 1, 14000],
  ['Ceramic coating: Signature coat, Koch-Chemie', 1, 38000],
  ['Interior detailing', 1, 4500],
], 'UPI');
warranty(car, inv1, 'ceramic', 'Koch-Chemie', 'Signature coat (9H)', 'Full body paint, glass and wheels', ccStart, 3, 6);

// Car: PPF front kit 10 months ago
const ppfStart = addMonths(t, -10);
const inv2 = invoice(car, ppfStart, [
  ['Paint protection film: front kit (bonnet, bumper, fenders, mirrors)', 1, 62000],
  ['Headlight PPF', 1, 3500],
], 'Card');
warranty(car, inv2, 'ppf', 'Garware', 'Gloss PPF, 190 micron', 'Bonnet, front bumper, fenders, mirrors, headlights', ppfStart, 5, 12);

// Bike: ceramic 18 months ago (third check-up due in 9 days)
const bikeStart = addDays(addMonths(t, -18), 9);
const inv3 = invoice(bike, bikeStart, [
  ['Motorcycle ceramic coating: tank, panels and wheels, Prismax', 1, 5750],
  ['Chain and engine detailing', 1, 850],
], 'UPI');
warranty(bike, inv3, 'ceramic', 'Prismax', 'Essential coat', 'Tank, side panels, fenders, wheels', bikeStart, 2, 6);

// Maintenance wash last month
invoice(car, addDays(t, -34), [['Maintenance wash with coating top-up', 1, 1150]], 'UPI');

// Mark past check-ups as done, except the most recent car ceramic one (left missed).
const past = db.all(`SELECT * FROM services WHERE customer_id = ? AND due_on < ? ORDER BY due_on`, cid, t);
const lastCeramicCar = past.filter((s) => s.vehicle_id === car).pop();
for (const s of past) if (s.id !== lastCeramicCar?.id) {
  const b = db.run(`INSERT INTO bookings (customer_id, vehicle_id, service_id, service, date, slot, status) VALUES (?, ?, ?, ?, ?, '11:30', 'completed')`,
    cid, s.vehicle_id, s.id, s.title, s.due_on).lastInsertRowid;
  db.run(`UPDATE services SET status = 'done', done_on = due_on, booking_id = ? WHERE id = ?`, b, s.id);
}

D.notify(cid, { kind: 'invoice', key: 'welcome', link: '#/', title: 'Welcome to your D24 Studio account',
  body: 'Your invoices, warranty certificates and service dates are all here.' });
D.runReminders(cid);
console.log('Seeded demo customer: 98765 43210 (Rahul Kamath)');
