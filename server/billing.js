'use strict';
// Invoices, payments, discount approvals and warranty issue.
const config = require('./config');
const db = require('./db');
const D = require('./domain');
const { staffNotify } = require('./staff-notify');
const { today, addDays, addMonths, isDate, str, fmtDate, bad, HttpError } = require('./util');

const PPF_TERMS = 'Covers yellowing, cracking, bubbling and delamination of the film under normal use. Excludes damage from accidents, stone chips that penetrate the film, improper washing and third-party repairs. Annual inspection at D24 Studio keeps this warranty valid.';
const CERAMIC_TERMS = 'Covers loss of gloss and hydrophobic performance of the coating under normal use. Excludes damage from accidents, scratches, chemical misuse and automatic car washes. Periodic inspection and maintenance at D24 Studio keeps this warranty valid.';

const money = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Validates a warranty specification (from a form or an invoice line). */
async function cleanWarrantySpec(w, q = db) {
  const kind = w.kind === 'ppf' ? 'ppf' : 'ceramic';
  const brand = await q.get(`SELECT * FROM brands WHERE name = ? AND ${kind} = 1`, str(w.brand, 40));
  if (!brand) throw bad(`Choose a ${kind === 'ppf' ? 'PPF' : 'ceramic'} brand for the warranty`);
  const product = str(w.product, 80);
  if (!product) throw bad('Warranty product / package is required');
  const years = Number(w.years);
  if (!(years > 0 && years <= 12)) throw bad('Warranty length must be 1–12 years');
  const interval = Math.round(Number(w.interval_months) || (kind === 'ppf' ? 12 : 6));
  if (interval < 1 || interval > 24) throw bad('Inspection interval must be 1–24 months');
  return { kind, brand: brand.name, product, coverage: str(w.coverage, 200) || null, years, interval_months: interval, terms: str(w.terms, 2000) || null };
}

/** Creates a warranty and its inspection schedule inside transaction tx. */
async function issueWarranty(tx, { customerId, vehicleId, invoiceId, spec, startsOn, auto, staffId, line }) {
  const starts = isDate(startsOn) ? startsOn : today();
  const ends = addDays(addMonths(starts, Math.round(spec.years * 12)), -1);
  const cert = await D.nextCertNo(tx, spec.kind, starts);
  const res = await tx.run(`INSERT INTO warranties (cert_no, customer_id, vehicle_id, invoice_id, kind, brand, product, coverage, starts_on, ends_on, interval_months, terms, auto, issued_by, invoice_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  cert, customerId, vehicleId, invoiceId ?? null, spec.kind, spec.brand, spec.product, spec.coverage, starts, ends, spec.interval_months,
  spec.terms || (spec.kind === 'ppf' ? PPF_TERMS : CERAMIC_TERMS), auto ? 1 : 0, staffId ?? null, line ?? null);
  const row = await tx.get('SELECT * FROM warranties WHERE id = ?', res.lastInsertRowid);
  await D.generateSchedule(tx, row);
  return row;
}

async function notifyWarranty(w, vehicle) {
  await D.notify(w.customer_id, { kind: 'warranty', key: `warranty-new:${w.id}`, link: `#/warranty/${w.id}`,
    title: `${w.kind === 'ppf' ? 'PPF' : 'Ceramic coating'} warranty issued`,
    body: `${w.brand} ${w.product} on your ${vehicle.make} ${vehicle.model}, valid until ${fmtDate(w.ends_on)}.` });
}

/**
 * Warranties are issued automatically once an invoice is fully paid, if it had no
 * discount and a line carries a warranty specification. Discounted invoices need
 * the Super Admin to issue the warranty.
 */
async function autoIssueWarranties(invoiceId) {
  const inv = await db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.amount_paid < inv.total || inv.discount > 0 || !inv.vehicle_id) return [];
  const items = JSON.parse(inv.items);
  const issued = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i].warranty) continue;
    const exists = await db.get('SELECT id FROM warranties WHERE invoice_id = ? AND invoice_line = ?', inv.id, i);
    if (exists) continue;
    const spec = await cleanWarrantySpec(items[i].warranty);
    const w = await db.tx((tx) => issueWarranty(tx, { customerId: inv.customer_id, vehicleId: inv.vehicle_id, invoiceId: inv.id, spec, startsOn: inv.issued_on, auto: true, line: i }));
    issued.push(w);
  }
  if (issued.length) {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = ?', inv.vehicle_id);
    for (const w of issued) await notifyWarranty(w, vehicle);
  }
  return issued;
}

/** Records a payment and updates the invoice's paid amount and status. */
async function recordPayment(invoiceId, { amount, mode, paidOn, staffId }) {
  const inv = await db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const balance = inv.total - inv.amount_paid;
  if (balance <= 0) throw bad('This invoice is already fully paid');
  const paise = amount === 'full' ? balance : Math.round(Number(amount) * 100);
  if (!(paise > 0)) throw bad('Enter the amount received');
  if (paise > balance) throw bad(`That’s more than the balance of ${money(balance)}`);
  const date = isDate(paidOn) ? paidOn : today();
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO payments (invoice_id, amount, mode, paid_on, recorded_by) VALUES (?, ?, ?, ?, ?)', inv.id, paise, str(mode, 30) || null, date, staffId ?? null);
    const paid = inv.amount_paid + paise;
    await tx.run('UPDATE invoices SET amount_paid = ?, status = ?, paid_on = ?, payment_mode = COALESCE(?, payment_mode) WHERE id = ?',
      paid, paid >= inv.total ? 'paid' : 'due', paid >= inv.total ? date : null, str(mode, 30) || null, inv.id);
  });
  return autoIssueWarranties(inv.id);
}

const paymentStatus = (inv) => (inv.amount_paid >= inv.total ? 'paid' : inv.amount_paid > 0 ? 'partial' : 'unpaid');

/**
 * Creates an invoice. Admins can't give a discount unless the Super Admin approved
 * a discount request for this customer; the Super Admin can discount directly.
 */
async function createInvoice(b, staff) {
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', Number(b.customer_id));
  if (!customer) throw new HttpError(404, 'Customer not found');
  const vehicle = b.vehicle_id ? await db.get('SELECT * FROM vehicles WHERE id = ? AND customer_id = ?', Number(b.vehicle_id), customer.id) : null;
  if (b.vehicle_id && !vehicle) throw bad('Vehicle not found');
  const issued = isDate(b.issued_on) ? b.issued_on : today();

  const items = [];
  for (const i of (Array.isArray(b.items) ? b.items : []).slice(0, 50)) {
    const line = { desc: str(i.desc, 160), qty: Math.max(1, Math.round(Number(i.qty) || 1)), rate: Math.round(Number(i.rate) * 100) };
    if (!line.desc || !(line.rate > 0)) continue;
    if (i.warranty && i.warranty.kind) {
      if (!vehicle) throw bad('Choose the vehicle for a line with a warranty');
      line.warranty = await cleanWarrantySpec(i.warranty);
    }
    items.push(line);
  }
  if (!items.length) throw bad('Add at least one line item with a price');
  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);

  // Discount rules
  let discount = 0;
  let request = null;
  if (b.discount_request_id) {
    request = await db.get(`SELECT * FROM discount_requests WHERE id = ? AND customer_id = ?`, Number(b.discount_request_id), customer.id);
    if (!request || request.status !== 'approved') throw bad('That discount hasn’t been approved (or was already used)');
    discount = request.amount;
  } else if (Number(b.discount) > 0) {
    if (staff.role !== 'super') throw new HttpError(403, 'Discounts need Super Admin approval. Send a discount request first.');
    discount = Math.round(Number(b.discount) * 100);
  }
  discount = Math.min(subtotal, discount);

  const taxRate = b.tax_rate === undefined || b.tax_rate === '' ? config.gstRate : Math.max(0, Math.min(28, Number(b.tax_rate) || 0));
  if (staff.role !== 'super' && taxRate !== config.gstRate) throw new HttpError(403, 'Only the Super Admin can change the GST rate');
  const tax = Math.round((subtotal - discount) * taxRate / 100);
  const total = subtotal - discount + tax;

  const inv = await db.tx(async (tx) => {
    const no = await D.nextInvoiceNo(tx, issued);
    const res = await tx.run(`INSERT INTO invoices (invoice_no, customer_id, vehicle_id, issued_on, items, subtotal, discount, tax_rate, tax, total, status, notes, discount_request_id, created_by, amount_paid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'due', ?, ?, ?, 0)`,
    no, customer.id, vehicle?.id ?? null, issued, JSON.stringify(items), subtotal, discount, taxRate, tax, total,
    str(b.notes, 500) || null, request?.id ?? null, staff.id);
    if (request) await tx.run(`UPDATE discount_requests SET status = 'used', invoice_id = ? WHERE id = ?`, res.lastInsertRowid, request.id);
    return tx.get('SELECT * FROM invoices WHERE id = ?', res.lastInsertRowid);
  });

  await D.notify(customer.id, { kind: 'invoice', key: `invoice:${inv.id}`, link: `#/invoice/${inv.id}`,
    title: `Invoice ${inv.invoice_no}`, body: `Your invoice for ${vehicle ? vehicle.make + ' ' + vehicle.model : 'recent work'} is ready to view.` });

  // Optional payment taken at the counter
  if (b.payment && b.payment.amount) {
    await recordPayment(inv.id, { amount: b.payment.amount, mode: b.payment.mode, paidOn: issued, staffId: staff.id });
  }
  return db.get('SELECT * FROM invoices WHERE id = ?', inv.id);
}

async function requestDiscount(b, staff) {
  const customer = await db.get('SELECT * FROM customers WHERE id = ?', Number(b.customer_id));
  if (!customer) throw new HttpError(404, 'Customer not found');
  const amount = Math.round(Number(b.amount) * 100);
  if (!(amount > 0)) throw bad('Enter the discount amount in ₹');
  const reason = str(b.reason, 300);
  if (!reason) throw bad('Give a reason for the discount');
  const vehicleId = b.vehicle_id ? Number(b.vehicle_id) : null;
  const r = await db.run('INSERT INTO discount_requests (customer_id, vehicle_id, amount, reason, requested_by, status) VALUES (?, ?, ?, ?, ?, ?)',
    customer.id, vehicleId, amount, reason, staff.id, staff.role === 'super' ? 'approved' : 'pending');
  if (staff.role !== 'super') {
    await staffNotify('super', { kind: 'discount', key: `discount-req:${r.lastInsertRowid}`, link: '#/approvals',
      title: `Discount request: ${money(amount)}`, body: `${staff.name} for ${customer.name || customer.phone}: ${reason}` });
  }
  return db.get('SELECT * FROM discount_requests WHERE id = ?', r.lastInsertRowid);
}

async function decideDiscount(id, { decision, amount }, staff) {
  const req = await db.get('SELECT * FROM discount_requests WHERE id = ?', Number(id));
  if (!req) throw new HttpError(404, 'Request not found');
  if (req.status !== 'pending') throw bad('This request has already been decided');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const finalAmount = status === 'approved' && Number(amount) > 0 ? Math.round(Number(amount) * 100) : req.amount;
  await db.run(`UPDATE discount_requests SET status = ?, amount = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`, status, finalAmount, staff.id, req.id);
  const c = await db.get('SELECT name, phone FROM customers WHERE id = ?', req.customer_id);
  await staffNotify('admin', { kind: 'discount', key: `discount-dec:${req.id}`, link: `#/customer/${req.customer_id}`,
    title: `Discount ${status}: ${money(finalAmount)}`, body: `For ${c?.name || c?.phone}. ${status === 'approved' ? 'You can now create the invoice.' : ''}` });
  return { ok: true };
}

module.exports = { cleanWarrantySpec, issueWarranty, notifyWarranty, autoIssueWarranties, recordPayment, paymentStatus, createInvoice, requestDiscount, decideDiscount, money };
