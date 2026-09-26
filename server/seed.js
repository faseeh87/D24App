'use strict';
// Seeds a demo customer (mobile 98765 43210) with vehicles, invoices, warranties
// and a service history whose dates are relative to today, so the demo always
// shows one missed and one upcoming service.   Usage: npm run seed [-- --reset]
// --reset only applies to the local SQLite file.
const fs = require('node:fs');
const config = require('./config');
if (process.argv.includes('--reset') && !config.dbUrl) {
  for (const f of [config.dbPath, config.dbPath + '-wal', config.dbPath + '-shm']) fs.rmSync(f, { force: true });
}

const db = require('./db');
const D = require('./domain');
const { today, addDays, addMonths } = require('./util');

const PHONE = '+919876543210';

async function main() {
  if (await db.get('SELECT 1 AS x FROM customers WHERE phone = ?', PHONE)) {
    console.log('Demo customer already exists.');
    return;
  }
  const t = today();
  const cid = (await db.run('INSERT INTO customers (phone, name, email, city) VALUES (?, ?, ?, ?)', PHONE, 'Rahul Kamath', 'rahul@example.com', 'Mangaluru')).lastInsertRowid;
  const car = (await db.run(`INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no) VALUES (?, 'car', 'BMW', '330i M Sport', 2023, 'Mineral White', 'KA 19 MN 2424')`, cid)).lastInsertRowid;
  const bike = (await db.run(`INSERT INTO vehicles (customer_id, kind, make, model, year, colour, reg_no) VALUES (?, 'bike', 'Royal Enfield', 'Interceptor 650', 2022, 'Black Ray', 'KA 19 EQ 0650')`, cid)).lastInsertRowid;

  const invoice = (vehicleId, issued, items, mode) => db.tx(async (tx) => {
    const list = items.map(([desc, qty, rupees]) => ({ desc, qty, rate: rupees * 100 }));
    const subtotal = list.reduce((s, i) => s + i.qty * i.rate, 0);
    const tax = Math.round(subtotal * config.gstRate / 100);
    const no = await D.nextInvoiceNo(tx, issued);
    const id = (await tx.run(`INSERT INTO invoices (invoice_no, customer_id, vehicle_id, issued_on, items, subtotal, discount, tax_rate, tax, total, status, paid_on, payment_mode, amount_paid)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'paid', ?, ?, ?)`, no, cid, vehicleId, issued, JSON.stringify(list), subtotal, config.gstRate, tax, subtotal + tax, issued, mode, subtotal + tax)).lastInsertRowid;
    await tx.run('INSERT INTO payments (invoice_id, amount, mode, paid_on) VALUES (?, ?, ?, ?)', id, subtotal + tax, mode, issued);
    return id;
  });

  const warranty = (vehicleId, invoiceId, kind, brand, product, coverage, starts, years, interval) => db.tx(async (tx) => {
    const ends = addDays(addMonths(starts, years * 12), -1);
    const cert = await D.nextCertNo(tx, kind, starts);
    const terms = kind === 'ppf'
      ? 'Covers yellowing, cracking, bubbling and delamination of the film under normal use. Excludes damage from accidents, stone chips that penetrate the film, improper washing and third-party repairs. Annual inspection at D24 Studio keeps this warranty valid.'
      : 'Covers loss of gloss and hydrophobic performance of the coating under normal use. Excludes damage from accidents, scratches, chemical misuse and automatic car washes. Periodic inspection and maintenance at D24 Studio keeps this warranty valid.';
    const id = (await tx.run(`INSERT INTO warranties (cert_no, customer_id, vehicle_id, invoice_id, kind, brand, product, coverage, starts_on, ends_on, interval_months, terms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, cert, cid, vehicleId, invoiceId, kind, brand, product, coverage, starts, ends, interval, terms)).lastInsertRowid;
    await D.generateSchedule(tx, await tx.get('SELECT * FROM warranties WHERE id = ?', id));
  });

  // Car: ceramic coating 18 months ago (third check-up missed 12 days ago)
  const ccStart = addDays(addMonths(t, -18), -12);
  const inv1 = await invoice(car, ccStart, [
    ['Paint correction, two-stage machine polish', 1, 14000],
    ['Ceramic coating: Signature coat, Koch-Chemie', 1, 38000],
    ['Interior detailing', 1, 4500],
  ], 'UPI');
  await warranty(car, inv1, 'ceramic', 'Koch-Chemie', 'Signature coat (9H)', 'Full body paint, glass and wheels', ccStart, 3, 6);

  // Car: PPF front kit 10 months ago
  const ppfStart = addMonths(t, -10);
  const inv2 = await invoice(car, ppfStart, [
    ['Paint protection film: front kit (bonnet, bumper, fenders, mirrors)', 1, 62000],
    ['Headlight PPF', 1, 3500],
  ], 'Card');
  await warranty(car, inv2, 'ppf', 'Garware', 'Gloss PPF, 190 micron', 'Bonnet, front bumper, fenders, mirrors, headlights', ppfStart, 5, 12);

  // Bike: ceramic 18 months ago (third check-up due in about 9 days)
  const bikeStart = addDays(addMonths(t, -18), 9);
  const inv3 = await invoice(bike, bikeStart, [
    ['Motorcycle ceramic coating: tank, panels and wheels, Prismax', 1, 5750],
    ['Chain and engine detailing', 1, 850],
  ], 'UPI');
  await warranty(bike, inv3, 'ceramic', 'Prismax', 'Essential coat', 'Tank, side panels, fenders, wheels', bikeStart, 2, 6);

  // Maintenance wash last month
  await invoice(car, addDays(t, -34), [['Maintenance wash with coating top-up', 1, 1150]], 'UPI');

  // Mark past check-ups as done, except the most recent car ceramic one (left missed).
  const past = await db.all('SELECT * FROM services WHERE customer_id = ? AND due_on < ? ORDER BY due_on', cid, t);
  const lastCeramicCar = past.filter((s) => s.vehicle_id === car).pop();
  for (const s of past) {
    if (s.id === lastCeramicCar?.id) continue;
    const b = (await db.run(`INSERT INTO bookings (customer_id, vehicle_id, service_id, service, date, slot, status) VALUES (?, ?, ?, ?, ?, '11:30', 'completed')`,
      cid, s.vehicle_id, s.id, s.title, s.due_on)).lastInsertRowid;
    await db.run(`UPDATE services SET status = 'done', done_on = due_on, booking_id = ? WHERE id = ?`, b, s.id);
  }

  await D.notify(cid, { kind: 'invoice', key: 'welcome', link: '#/', title: 'Welcome to your D24 Studio account',
    body: 'Your invoices, warranty certificates and service dates are all here.' });
  await D.runReminders(cid);
  console.log('Seeded demo customer: 98765 43210 (Rahul Kamath)');
}

main().catch((e) => { console.error(e); process.exit(1); });
