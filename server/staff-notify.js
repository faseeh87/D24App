'use strict';
// Notifications for studio staff. audience: 'super' (Super Admin only), 'admin' (Admins only) or 'all'.
const db = require('./db');

async function staffNotify(audience, { kind, title, body, link, key }) {
  const r = await db.run(
    'INSERT OR IGNORE INTO staff_notifications (audience, kind, title, body, link, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)',
    audience, kind, title, body || null, link || null, key || null,
  );
  return r.changes > 0;
}

/** Notifications a staff member can see, by role. */
const audienceFor = (role) => (role === 'super' ? ['super', 'all'] : ['admin', 'all']);

module.exports = { staffNotify, audienceFor };
