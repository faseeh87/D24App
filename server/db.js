'use strict';
// Database layer with two interchangeable backends, both SQLite dialect:
//  - local: Node's built-in node:sqlite file (development, VPS, tests)
//  - remote: Turso / libSQL over its HTTP API (Vercel and other serverless hosts)
// All calls are async so route code is identical for both.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  city TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'car' CHECK (kind IN ('car','bike')),
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  colour TEXT,
  reg_no TEXT NOT NULL,
  vin TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (customer_id, reg_no)
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  window_start INTEGER,
  window_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer','admin')),
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ceramic INTEGER NOT NULL DEFAULT 0,
  ppf INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  issued_on TEXT NOT NULL,
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL,
  tax INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','due')),
  paid_on TEXT,
  payment_mode TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS warranties (
  id INTEGER PRIMARY KEY,
  cert_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ceramic','ppf')),
  brand TEXT NOT NULL,
  product TEXT NOT NULL,
  coverage TEXT,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  interval_months INTEGER NOT NULL DEFAULT 6,
  terms TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  warranty_id INTEGER REFERENCES warranties(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','booked','done','skipped')),
  done_on TEXT,
  booking_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service TEXT NOT NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super','admin')),
  pin_hash TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS staff_notifications (
  id INTEGER PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'super',
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS discount_requests (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','used')),
  requested_by INTEGER,
  decided_by INTEGER,
  decided_at TEXT,
  invoice_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  mode TEXT,
  paid_on TEXT NOT NULL,
  recorded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  spent_on TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('rent','inventory','salary','maintenance')),
  amount INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  brand TEXT NOT NULL,
  sub_brand TEXT NOT NULL,
  unit TEXT NOT NULL,
  pack_size REAL,
  quantity REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  unit_cost REAL,
  restock_seq INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory_moves (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  booking_id INTEGER,
  cost INTEGER,
  staff_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_standards (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('car','bike')),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  UNIQUE (service, kind, category)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS social_snapshots (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  taken_on TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (platform, taken_on)
);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_warranties_customer ON warranties(customer_id);
CREATE INDEX IF NOT EXISTS idx_services_customer ON services(customer_id, status, due_on);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, slot, status);
CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_id, read_at);
INSERT OR IGNORE INTO brands (name, ceramic, ppf) VALUES ('Prismax', 1, 1);
INSERT OR IGNORE INTO brands (name, ceramic, ppf) VALUES ('Garware', 0, 1);
INSERT OR IGNORE INTO brands (name, ceramic, ppf) VALUES ('Koch-Chemie', 1, 0)
`;
const STATEMENTS = SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ local backend
function localBackend() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const conn = new DatabaseSync(config.dbPath);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const exec = (sql) => conn.prepare(sql);
  const q = {
    get: async (sql, p) => exec(sql).get(...p) ?? undefined,
    all: async (sql, p) => exec(sql).all(...p),
    run: async (sql, p) => {
      const r = exec(sql).run(...p);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
  };
  // One connection shared by concurrent requests: serialise transactions and
  // make ordinary queries wait while a transaction is open.
  let chain = Promise.resolve();
  const guard = (fn) => async (sql, ...p) => { await chain; return fn(sql, p); };
  return {
    get: guard(q.get), all: guard(q.all), run: guard(q.run),
    tx(fn) {
      const run = chain.then(async () => {
        conn.exec('BEGIN IMMEDIATE');
        const t = { get: (s, ...p) => q.get(s, p), all: (s, ...p) => q.all(s, p), run: (s, ...p) => q.run(s, p) };
        try { const out = await fn(t); conn.exec('COMMIT'); return out; }
        catch (e) { conn.exec('ROLLBACK'); throw e; }
      });
      chain = run.catch(() => {});
      return run;
    },
    async migrate() { conn.exec(SCHEMA); },
    async columns(table) { return conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name); },
  };
}

// ------------------------------------------------------------------ Turso / libSQL (HTTP)
function remoteBackend(url, token) {
  const base = url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const encode = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    return { type: 'text', value: String(v) };
  };
  const decode = (c) => {
    switch (c.type) {
      case 'null': return null;
      case 'integer': return Number(c.value);
      case 'float': return Number(c.value);
      case 'blob': return Buffer.from(c.base64 || '', 'base64');
      default: return c.value;
    }
  };

  async function pipeline(requests, baton) {
    const res = await fetch(base + '/v2/pipeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify({ baton: baton || null, requests }),
    });
    if (!res.ok) throw new Error(`Database HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    for (const r of body.results) {
      if (r.type === 'error') throw new Error('Database error: ' + (r.error?.message || 'unknown'));
    }
    return body;
  }
  const execReq = (sql, args) => ({ type: 'execute', stmt: { sql, args: args.map(encode) } });
  const shape = (result) => {
    const cols = result.cols.map((c) => c.name);
    return {
      rows: result.rows.map((row) => Object.fromEntries(row.map((cell, i) => [cols[i], decode(cell)]))),
      changes: Number(result.affected_row_count || 0),
      lastInsertRowid: result.last_insert_rowid == null ? 0 : Number(result.last_insert_rowid),
    };
  };
  async function once(sql, p) {
    const body = await pipeline([execReq(sql, p), { type: 'close' }]);
    return shape(body.results[0].response.result);
  }
  const api = (exec) => ({
    get: async (sql, ...p) => (await exec(sql, p)).rows[0],
    all: async (sql, ...p) => (await exec(sql, p)).rows,
    run: async (sql, ...p) => { const r = await exec(sql, p); return { lastInsertRowid: r.lastInsertRowid, changes: r.changes }; },
  });

  return {
    ...api(once),
    async tx(fn) {
      let baton = null;
      let body = await pipeline([execReq('BEGIN IMMEDIATE', [])]);
      baton = body.baton;
      // A transaction is one stream with a single baton, so its statements must run one at a time.
      let queue = Promise.resolve();
      const step = (sql, p) => {
        const run = queue.then(async () => {
          body = await pipeline([execReq(sql, p)], baton);
          baton = body.baton;
          return shape(body.results[0].response.result);
        });
        queue = run.catch(() => {});
        return run;
      };
      try {
        const out = await fn(api(step));
        await queue;
        await pipeline([execReq('COMMIT', []), { type: 'close' }], baton);
        return out;
      } catch (e) {
        await queue;
        await pipeline([execReq('ROLLBACK', []), { type: 'close' }], baton).catch(() => {});
        throw e;
      }
    },
    async migrate() {
      await pipeline([...STATEMENTS.map((s) => execReq(s, [])), { type: 'close' }]);
    },
    async columns(table) {
      return (await once(`PRAGMA table_info(${table})`, [])).rows.map((r) => r.name);
    },
  };
}

function missingBackend() {
  const fail = async () => {
    const e = new Error('The app’s database is not connected yet. Please try again later.');
    e.status = 503;
    console.error('[db] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not set');
    throw e;
  };
  return { get: fail, all: fail, run: fail, tx: fail, migrate: fail };
}

// Serverless hosts have no persistent disk, so they must use Turso.
const backend = config.dbUrl ? remoteBackend(config.dbUrl, config.dbToken)
  : config.vercel ? missingBackend() : localBackend();

// ------------------------------------------------------------------ migrations
// Each runs once; applied ids are recorded in the meta table.
const addColumn = (table, col, def) => async (b) => {
  if (!(await b.columns(table)).includes(col)) await b.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
};
const MIGRATIONS = [
  ['m1_invoice_payments', async (b) => {
    await addColumn('invoices', 'amount_paid', 'INTEGER NOT NULL DEFAULT 0')(b);
    await addColumn('invoices', 'discount_request_id', 'INTEGER')(b);
    await addColumn('invoices', 'created_by', 'INTEGER')(b);
    await b.run(`INSERT INTO payments (invoice_id, amount, mode, paid_on)
                 SELECT id, total, payment_mode, COALESCE(paid_on, issued_on) FROM invoices WHERE status = 'paid' AND amount_paid = 0`);
    await b.run(`UPDATE invoices SET amount_paid = total WHERE status = 'paid' AND amount_paid = 0`);
  }],
  ['m2_warranty_meta', async (b) => {
    await addColumn('warranties', 'auto', 'INTEGER NOT NULL DEFAULT 0')(b);
    await addColumn('warranties', 'issued_by', 'INTEGER')(b);
    await addColumn('warranties', 'invoice_line', 'INTEGER')(b);
  }],
  ['m3_sessions_staff', addColumn('sessions', 'staff_id', 'INTEGER')],
  ['m4_bookings_completed_by', addColumn('bookings', 'completed_by', 'INTEGER')],
  // One-time clean-up requested by the studio (Sep 2026): remove all appointments and warranties so far.
  ['m5_purge_bookings_warranties_2026_09', async (b) => {
    await b.run(`DELETE FROM notifications WHERE kind IN ('booking','warranty','missed','upcoming')`);
    await b.run('DELETE FROM services');
    await b.run('DELETE FROM bookings');
    await b.run('DELETE FROM warranties');
  }],
  // Starting usage standards per vehicle (editable by the Super Admin).
  ['m6_default_usage_standards', async (b) => {
    const rows = [
      ['Car wash', 'car', 'Shampoo', 40], ['Maintenance wash', 'car', 'Shampoo', 40], ['Maintenance wash', 'car', 'Coating top-up / detailer', 30],
      ['Ceramic coating', 'car', 'Ceramic coating', 50], ['Ceramic coating', 'car', 'Polish / compound', 100],
      ['Paint correction', 'car', 'Polish / compound', 150], ['Paint protection film (PPF)', 'car', 'PPF film', 60],
      ['Interior detailing', 'car', 'Interior cleaner', 150], ['Headlight restoration', 'car', 'Polish / compound', 30],
      ['Engine bay detailing', 'car', 'Degreaser', 100],
      ['Bike wash', 'bike', 'Shampoo', 20], ['Ceramic coating', 'bike', 'Ceramic coating', 15], ['Paint protection film (PPF)', 'bike', 'PPF film', 10],
    ];
    for (const r of rows) await b.run('INSERT OR IGNORE INTO usage_standards (service, kind, category, amount) VALUES (?, ?, ?, ?)', ...r);
  }],
];

async function runMigrations(b) {
  const done = new Set((await b.all(`SELECT key FROM meta WHERE key LIKE 'migration:%'`)).map((r) => r.key.slice(10)));
  for (const [id, fn] of MIGRATIONS) {
    if (done.has(id)) continue;
    await fn(b);
    await b.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'migration:' + id, new Date().toISOString());
  }
}

// Schema and migrations run once per process (cold start).
let ready = null;
const init = () => (ready ||= backend.migrate().then(() => runMigrations(backend)).catch((e) => { ready = null; throw e; }));
const wrap = (fn) => async (...a) => { await init(); return fn(...a); };

module.exports = {
  init,
  kind: config.dbUrl ? 'turso' : 'sqlite',
  get: wrap(backend.get),
  all: wrap(backend.all),
  run: wrap(backend.run),
  /** Runs fn(t) in a transaction; t has get/all/run bound to that transaction. */
  tx: wrap(backend.tx),
};
