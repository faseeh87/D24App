'use strict';
// Minimal libSQL "Hrana over HTTP" (v2 pipeline) server backed by node:sqlite.
// Lets the test suite exercise the Turso backend without a network connection.
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function start(file, port) {
  const streams = new Map();
  const open = () => {
    const c = new DatabaseSync(file);
    c.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    return c;
  };
  const decode = (a) => (a.type === 'null' ? null : a.type === 'integer' ? Number(a.value) : a.type === 'float' ? Number(a.value) : a.value);
  const encode = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    return { type: 'text', value: String(v) };
  };
  function execute(conn, stmt) {
    const st = conn.prepare(stmt.sql);
    const args = (stmt.args || []).map(decode);
    const cols = st.columns().map((c) => ({ name: c.name, decltype: null }));
    if (cols.length) {
      const rows = st.all(...args);
      return { cols, rows: rows.map((r) => cols.map((c) => encode(r[c.name]))), affected_row_count: conn.prepare('SELECT changes() AS n').get().n, last_insert_rowid: String(conn.prepare('SELECT last_insert_rowid() AS n').get().n) };
    }
    const r = st.run(...args);
    return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
  }
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end(); }
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      const body = JSON.parse(buf);
      let baton = body.baton;
      let conn = baton ? streams.get(baton) : open();
      if (!conn) { res.writeHead(400); return res.end('{"message":"bad baton"}'); }
      if (baton) streams.delete(baton);
      const results = [];
      let closed = false;
      for (const r of body.requests) {
        if (r.type === 'close') { conn.close(); closed = true; results.push({ type: 'ok', response: { type: 'close' } }); continue; }
        try { results.push({ type: 'ok', response: { type: 'execute', result: execute(conn, r.stmt) } }); }
        catch (e) { results.push({ type: 'error', error: { message: e.message } }); }
      }
      let newBaton = null;
      if (!closed) { newBaton = crypto.randomBytes(8).toString('hex'); streams.set(newBaton, conn); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ baton: newBaton, base_url: null, results }));
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

module.exports = { start };
if (require.main === module) start(process.argv[2] || 'shim.db', Number(process.argv[3] || 8089)).then(() => console.log('hrana shim up'));
