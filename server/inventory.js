'use strict';
// Inventory: stock by brand / sub-brand, usage standards per service and vehicle
// class, deduction on completed bookings, low-stock alerts and the booking stop.
const config = require('./config');
const db = require('./db');
const { staffNotify } = require('./staff-notify');
const { bad, HttpError } = require('./util');

/** Stock categories and the unit each is measured in. */
const CATEGORIES = [
  { name: 'Ceramic coating', unit: 'ml' },
  { name: 'PPF film', unit: 'sq ft' },
  { name: 'Shampoo', unit: 'ml' },
  { name: 'Polish / compound', unit: 'ml' },
  { name: 'Coating top-up / detailer', unit: 'ml' },
  { name: 'Interior cleaner', unit: 'ml' },
  { name: 'Degreaser', unit: 'ml' },
  { name: 'Dressing', unit: 'ml' },
  { name: 'Consumables', unit: 'pcs' },
];
const unitOf = (category) => CATEGORIES.find((c) => c.name === category)?.unit || 'pcs';

const fmtQty = (n, unit) => `${Math.round(n * 100) / 100} ${unit}`;

/**
 * For one vehicle class, works out which services can be booked right now.
 * A category is only tracked once at least one item exists in it. Stock already
 * promised to open bookings (requested / confirmed) is set aside.
 * Returns { [service]: { available, reason } }.
 */
async function availability(kind, q = db) {
  const [standards, items, open] = await Promise.all([
    q.all('SELECT * FROM usage_standards'),
    q.all('SELECT category, SUM(quantity) AS qty, COUNT(*) AS n FROM inventory_items WHERE active = 1 GROUP BY category'),
    q.all(`SELECT b.service, v.kind FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE b.status IN ('requested','confirmed')`),
  ]);
  const stock = Object.fromEntries(items.map((i) => [i.category, i.qty]));
  const reserved = {};
  for (const b of open) {
    for (const s of standards) if (s.service === b.service && s.kind === b.kind) reserved[s.category] = (reserved[s.category] || 0) + s.amount;
  }
  const out = {};
  for (const svc of config.servicesFor(kind)) {
    out[svc] = { available: true, reason: null };
    for (const s of standards.filter((x) => x.service === svc && x.kind === kind)) {
      if (!(s.category in stock)) continue; // not tracked yet
      const free = stock[s.category] - (reserved[s.category] || 0);
      if (free < s.amount) {
        out[svc] = { available: false, reason: `${s.category} is below one vehicle (${fmtQty(Math.max(0, free), unitOf(s.category))} free, ${fmtQty(s.amount, unitOf(s.category))} needed)` };
        break;
      }
    }
  }
  return out;
}

async function assertBookable(service, kind, q = db) {
  const a = (await availability(kind, q))[service];
  if (a && !a.available) {
    throw new HttpError(409, `${service} can’t be booked right now while we restock. Please call the studio or choose another service.`);
  }
}

/** What a completed booking will use: standards with the items that can be picked for each. */
async function plannedUsage(booking, kind, q = db) {
  const standards = await q.all('SELECT * FROM usage_standards WHERE service = ? AND kind = ?', booking.service, kind);
  const out = [];
  for (const s of standards) {
    const items = await q.all('SELECT * FROM inventory_items WHERE active = 1 AND category = ? ORDER BY quantity DESC', s.category);
    if (!items.length) continue; // category not tracked
    out.push({ category: s.category, amount: s.amount, unit: unitOf(s.category), items });
  }
  return out;
}

/**
 * Deducts stock for a completed booking. picks = { [category]: itemId } (staff choice);
 * defaults to the item with the most stock. Runs inside the caller's transaction.
 * Returns the affected item ids.
 */
async function deductForBooking(tx, booking, kind, picks, staffId) {
  const plan = await plannedUsage(booking, kind, tx);
  const touched = [];
  for (const p of plan) {
    const chosenId = Number(picks?.[p.category]) || p.items[0].id;
    const item = p.items.find((i) => i.id === chosenId);
    if (!item) throw bad(`Choose a ${p.category} item`);
    if (item.quantity < p.amount) {
      throw bad(`Not enough ${item.brand} ${item.sub_brand}: ${fmtQty(item.quantity, item.unit)} left, ${fmtQty(p.amount, p.unit)} needed. Pick another item or record a restock.`);
    }
    await tx.run('UPDATE inventory_items SET quantity = quantity - ? WHERE id = ?', p.amount, item.id);
    await tx.run(`INSERT INTO inventory_moves (item_id, delta, reason, booking_id, staff_id) VALUES (?, ?, 'used', ?, ?)`,
      item.id, -p.amount, booking.id, staffId ?? null);
    touched.push(item.id);
  }
  return touched;
}

/** Raises low-stock and booking-stop alerts to the Super Admin (once per restock cycle). */
async function checkStockAlerts() {
  const items = await db.all('SELECT * FROM inventory_items WHERE active = 1');
  for (const i of items) {
    if (i.quantity <= i.reorder_level) {
      await staffNotify('super', {
        kind: 'inventory', key: `lowstock:${i.id}:${i.restock_seq}`, link: '#/inventory',
        title: `Restock ${i.brand} ${i.sub_brand}`,
        body: `${fmtQty(i.quantity, i.unit)} left (reorder level ${fmtQty(i.reorder_level, i.unit)}).`,
      });
    }
  }
  // Booking stop per category
  const seqs = Object.fromEntries((await db.all('SELECT category, SUM(restock_seq) AS s FROM inventory_items GROUP BY category')).map((r) => [r.category, r.s]));
  for (const kind of ['car', 'bike']) {
    const av = await availability(kind);
    for (const [svc, a] of Object.entries(av)) {
      if (a.available) continue;
      const cat = a.reason.split(' is below')[0];
      await staffNotify('super', {
        kind: 'inventory', key: `bookingstop:${kind}:${svc}:${seqs[cat] || 0}`, link: '#/inventory',
        title: `Bookings paused: ${svc} (${kind === 'bike' ? 'motorcycles' : 'cars'})`,
        body: `${a.reason}. Customers can’t book this service until you restock.`,
      });
    }
  }
}

module.exports = { CATEGORIES, unitOf, availability, assertBookable, plannedUsage, deductForBooking, checkStockAlerts, fmtQty };
