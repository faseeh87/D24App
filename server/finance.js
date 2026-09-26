'use strict';
// Revenue, expenses and next-month expenditure forecast (Super Admin only).
const db = require('./db');
const { today, addDays } = require('./util');

const EXPENSE_CATEGORIES = ['rent', 'inventory', 'salary', 'maintenance'];

function monthStart(d) { return d.slice(0, 8) + '01'; }
function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function weekStart(d) {
  const day = new Date(d + 'T00:00:00Z').getUTCDay(); // 0 Sun
  return addDays(d, -((day + 6) % 7)); // Monday
}

/** Invoiced (by invoice date) and collected (by payment date) for day / week / month / year. */
async function revenue() {
  const t = today();
  const periods = {
    day: [t, t],
    week: [weekStart(t), t],
    month: [monthStart(t), t],
    year: [t.slice(0, 4) + '-01-01', t],
  };
  const out = {};
  for (const [k, [from, to]] of Object.entries(periods)) {
    const [inv, pay, exp] = await Promise.all([
      db.get('SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount),0) AS discount, COUNT(*) AS n FROM invoices WHERE issued_on BETWEEN ? AND ?', from, to),
      db.get('SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE paid_on BETWEEN ? AND ?', from, to),
      db.get('SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE spent_on BETWEEN ? AND ?', from, to),
    ]);
    out[k] = { from, to, invoiced: inv.total, invoices: inv.n, discounts: inv.discount, collected: pay.total, expenses: exp.total, net: pay.total - exp.total };
  }
  const due = await db.get('SELECT COALESCE(SUM(total - amount_paid),0) AS n FROM invoices WHERE amount_paid < total');
  out.outstanding = due.n;
  // Last 12 months, collected vs expenses
  const months = [];
  const cur = t.slice(0, 7);
  for (let i = 11; i >= 0; i--) {
    const ym = shiftMonth(cur, -i);
    const [p, e] = await Promise.all([
      db.get('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE substr(paid_on,1,7) = ?', ym),
      db.get('SELECT COALESCE(SUM(amount),0) AS n FROM expenses WHERE substr(spent_on,1,7) = ?', ym),
    ]);
    months.push({ month: ym, collected: p.n, expenses: e.n });
  }
  out.months = months;
  return out;
}

/**
 * Next month's expected spend per category, from the data so far:
 * - rent and salary are fixed costs: the most recent month that has an entry
 * - inventory and maintenance vary: weighted average of the last 3 months (50/30/20)
 * - inventory is floored at the value of stock actually used per month (usage x unit cost)
 */
async function forecast() {
  const cur = today().slice(0, 7);
  const next = shiftMonth(cur, 1);
  const history = [];
  for (let i = 5; i >= 0; i--) history.push(shiftMonth(cur, -i));
  const rows = await db.all(`SELECT category, substr(spent_on,1,7) AS ym, SUM(amount) AS total FROM expenses
                             WHERE spent_on >= ? GROUP BY category, ym`, history[0] + '-01');
  const by = {};
  for (const r of rows) (by[r.category] ||= {})[r.ym] = r.total;

  // Stock value used per month over the last 90 days
  const used = await db.get(`SELECT COALESCE(SUM(-m.delta * COALESCE(i.unit_cost, 0)), 0) AS v FROM inventory_moves m
                             JOIN inventory_items i ON i.id = m.item_id WHERE m.reason = 'used' AND m.created_at >= datetime('now', '-90 days')`);
  const usagePerMonth = Math.round((used.v * 100) / 3); // unit_cost is in ₹, amounts in paise

  const lines = EXPENSE_CATEGORIES.map((cat) => {
    const series = history.map((ym) => by[cat]?.[ym] || 0);
    let value = 0; let method = 'No data yet';
    if (cat === 'rent' || cat === 'salary') {
      const last = [...history].reverse().find((ym) => by[cat]?.[ym]);
      if (last) { value = by[cat][last]; method = `Fixed cost: same as ${last}`; }
    } else {
      const last3 = series.slice(-4, -1); // three completed months before this one
      const withThis = series.slice(-3);
      const src = last3.some(Boolean) ? last3 : withThis;
      const w = [0.2, 0.3, 0.5];
      const weight = src.reduce((s, v, i) => s + (v ? w[i] : 0), 0);
      if (weight) { value = Math.round(src.reduce((s, v, i) => s + v * w[i], 0) / weight); method = 'Weighted average of recent months'; }
      if (cat === 'inventory' && usagePerMonth > value) { value = usagePerMonth; method = 'Stock used per month × unit cost'; }
    }
    return { category: cat, forecast: value, method, history: history.map((ym, i) => ({ month: ym, total: series[i] })) };
  });
  return { month: next, total: lines.reduce((s, l) => s + l.forecast, 0), lines };
}

module.exports = { revenue, forecast, EXPENSE_CATEGORIES };
