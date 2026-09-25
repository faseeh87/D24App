'use strict';
// Business logic shared by the customer and staff APIs.
const config = require('./config');
const db = require('./db');
const sms = require('./sms');
const { today, addMonths, addDays, daysBetween, fmtDate } = require('./util');

// ---------- presentation helpers ----------
function vehicleLabel(v) {
  return v ? `${v.make} ${v.model}` : '';
}

function serviceView(s) {
  const t = today();
  let state = s.status;
  if (s.status === 'due') {
    const d = daysBetween(t, s.due_on);
    state = d < 0 ? 'missed' : d <= config.reminders.upcomingDays ? 'upcoming' : 'scheduled';
  }
  return { ...s, state, days: daysBetween(t, s.due_on) };
}

const vehicleById = (id) => db.get('SELECT * FROM vehicles WHERE id = ?', id);
const mapAll = (rows, fn) => Promise.all(rows.map(fn));

async function warrantyView(w) {
  const t = today();
  const [rows, vehicle] = await Promise.all([
    db.all('SELECT * FROM services WHERE warranty_id = ? ORDER BY due_on', w.id),
    vehicleById(w.vehicle_id),
  ]);
  const services = rows.map(serviceView);
  const total = Math.max(1, daysBetween(w.starts_on, w.ends_on));
  const elapsed = Math.min(total, Math.max(0, daysBetween(w.starts_on, t)));
  const overdue = services.filter((s) => s.state === 'missed');
  const lapsed = overdue.some((s) => -s.days > config.reminders.warrantyGraceDays);
  let health = 'active';
  if (t > w.ends_on) health = 'expired';
  else if (lapsed) health = 'at-risk';
  else if (overdue.length) health = 'attention';
  return {
    ...w,
    vehicle,
    vehicle_label: vehicleLabel(vehicle),
    services,
    progress: Math.round((elapsed / total) * 100),
    days_left: Math.max(0, daysBetween(t, w.ends_on)),
    health,
    next_service: services.find((s) => s.status === 'due' || s.status === 'booked') || null,
  };
}

async function invoiceView(i) {
  const vehicle = i.vehicle_id ? await vehicleById(i.vehicle_id) : null;
  return { ...i, items: JSON.parse(i.items), vehicle, vehicle_label: vehicleLabel(vehicle) };
}

async function bookingView(b) {
  const vehicle = await vehicleById(b.vehicle_id);
  return { ...b, vehicle, vehicle_label: vehicleLabel(vehicle) };
}

// ---------- numbering (call inside a transaction: t = transaction handle) ----------
function fiscalYear(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

async function nextInvoiceNo(t, issuedOn) {
  const prefix = `D24/${fiscalYear(issuedOn)}/`;
  const row = await t.get('SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1', prefix + '%');
  const n = row ? Number(row.invoice_no.split('/').pop()) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

async function nextCertNo(t, kind, startsOn) {
  const prefix = `D24-${kind === 'ppf' ? 'PPF' : 'CC'}-${startsOn.slice(0, 4)}-`;
  const row = await t.get('SELECT cert_no FROM warranties WHERE cert_no LIKE ? ORDER BY id DESC LIMIT 1', prefix + '%');
  const n = row ? Number(row.cert_no.split('-').pop()) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

// ---------- warranty service schedule ----------
function serviceTitle(kind) {
  return kind === 'ppf' ? 'PPF inspection' : 'Ceramic coating inspection';
}

/** Creates every periodic check-up from start to end of the warranty. */
async function generateSchedule(t, w) {
  for (let i = 1; ; i++) {
    const due = addMonths(w.starts_on, w.interval_months * i);
    if (due > w.ends_on) break;
    await t.run('INSERT INTO services (customer_id, vehicle_id, warranty_id, title, due_on) VALUES (?, ?, ?, ?, ?)',
      w.customer_id, w.vehicle_id, w.id, serviceTitle(w.kind), due);
  }
}

// ---------- notifications ----------
/** Inserts a notification once per dedupe key. Returns true when new. */
async function notify(customerId, { kind, title, body, link, key, textSms }) {
  const r = await db.run(
    'INSERT OR IGNORE INTO notifications (customer_id, kind, title, body, link, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)',
    customerId, kind, title, body || null, link || null, key || null,
  );
  if (r.changes && textSms && config.sms.reminders) {
    const c = await db.get('SELECT phone FROM customers WHERE id = ?', customerId);
    if (c) await sms.sendMessage(c.phone, textSms).catch((e) => console.error('[sms] reminder failed', e.message));
  }
  return r.changes > 0;
}

/**
 * Scans service dates, bookings and warranties and raises reminders.
 * Idempotent: each reminder has a dedupe key, so running it often is safe.
 */
async function runReminders(customerId) {
  const t = today();
  const horizon = addDays(t, config.reminders.upcomingDays);
  const only = (alias) => (customerId ? ` AND ${alias}.customer_id = ${Number(customerId)}` : '');

  const due = await db.all(`SELECT s.*, v.make, v.model, v.reg_no FROM services s JOIN vehicles v ON v.id = s.vehicle_id
                      WHERE s.status = 'due' AND s.due_on <= ?${only('s')}`, horizon);
  for (const s of due) {
    const car = `${s.make} ${s.model} (${s.reg_no})`;
    if (s.due_on < t) {
      await notify(s.customer_id, {
        kind: 'missed', key: `missed:${s.id}`, link: `#/book?service=${s.id}`,
        title: `Missed: ${s.title}`,
        body: `Your ${car} was due on ${fmtDate(s.due_on)}. Book soon to keep your warranty active.`,
        textSms: `D24 Studio: ${s.title} for ${s.reg_no} was due on ${fmtDate(s.due_on)}. Book at d24.studio to keep your warranty active.`,
      });
    } else {
      await notify(s.customer_id, {
        kind: 'upcoming', key: `upcoming:${s.id}`, link: `#/book?service=${s.id}`,
        title: `Coming up: ${s.title}`,
        body: `Your ${car} is due on ${fmtDate(s.due_on)}.`,
        textSms: `D24 Studio: ${s.title} for ${s.reg_no} is due on ${fmtDate(s.due_on)}. Book your slot at d24.studio.`,
      });
    }
  }

  const soon = await db.all(`SELECT b.*, v.reg_no FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
                       WHERE b.status = 'confirmed' AND b.date BETWEEN ? AND ?${only('b')}`, t, addDays(t, 1));
  for (const b of soon) {
    await notify(b.customer_id, {
      kind: 'booking', key: `booking-soon:${b.id}:${b.date === t ? 'today' : 'tomorrow'}`, link: '#/book',
      title: b.date === t ? 'Your appointment is today' : 'Your appointment is tomorrow',
      body: `${b.service} · ${fmtDate(b.date)} at ${b.slot}. See you at the studio.`,
    });
  }

  const expiring = await db.all(`SELECT w.* FROM warranties w WHERE w.ends_on BETWEEN ? AND ?${only('w')}`, t, addDays(t, 30));
  for (const w of expiring) {
    await notify(w.customer_id, {
      kind: 'warranty', key: `warranty-exp:${w.id}`, link: `#/warranty/${w.id}`,
      title: `${w.kind === 'ppf' ? 'PPF' : 'Ceramic'} warranty ends soon`,
      body: `Certificate ${w.cert_no} is valid until ${fmtDate(w.ends_on)}. Ask us about renewal.`,
    });
  }
}

// ---------- slots ----------
async function slotAvailability(date, q = db) {
  const rows = await q.all(`SELECT slot, COUNT(*) AS n FROM bookings WHERE date = ? AND status IN ('requested','confirmed')
                       GROUP BY slot`, date);
  const used = Object.fromEntries(rows.map((r) => [r.slot, r.n]));
  const t = today();
  const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return config.booking.slots.map((slot) => {
    const left = Math.max(0, config.booking.slotCapacity - (used[slot] || 0));
    const past = date === t && slot <= nowHm;
    return { slot, left: past ? 0 : left, available: !past && left > 0 };
  });
}

module.exports = {
  serviceView, warrantyView, invoiceView, bookingView, vehicleLabel, mapAll,
  nextInvoiceNo, nextCertNo, generateSchedule, notify, runReminders, slotAvailability, serviceTitle,
};
