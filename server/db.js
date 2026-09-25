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
      const step = async (sql, p) => {
        body = await pipeline([execReq(sql, p)], baton);
        baton = body.baton;
        return shape(body.results[0].response.result);
      };
      try {
        const out = await fn(api(step));
        await pipeline([execReq('COMMIT', []), { type: 'close' }], baton);
        return out;
      } catch (e) {
        await pipeline([execReq('ROLLBACK', []), { type: 'close' }], baton).catch(() => {});
        throw e;
      }
    },
    async migrate() {
      await pipeline([...STATEMENTS.map((s) => execReq(s, [])), { type: 'close' }]);
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

// Schema is created once per process (cold start).
let ready = null;
const init = () => (ready ||= backend.migrate().catch((e) => { ready = null; throw e; }));
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
