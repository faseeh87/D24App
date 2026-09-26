'use strict';
// Builds the request handler shared by the local server (server/index.js)
// and the Vercel function (api/index.js).
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const { Router, createHandler } = require('./http');
const { runReminders } = require('./domain');
const { cleanup } = require('./auth');
const INV = require('./inventory');
const SOCIAL = require('./social');
const { HttpError } = require('./util');

const router = new Router();
require('./routes-customer')(router);
require('./routes-admin')(router);

router.get('/api/health', async () => { await db.init(); return { ok: true, db: db.kind }; });

/** Daily job (Vercel Cron) — raises reminders for everyone and tidies expired sessions. */
async function sweep() {
  await runReminders();
  await cleanup();
  await INV.checkStockAlerts();
  const social = await SOCIAL.check().catch((e) => ({ error: e.message }));
  if (Object.keys(social).length) console.log('[social]', JSON.stringify(social).slice(0, 500));
}
router.get('/api/cron/reminders', async (ctx) => {
  // Vercel Cron sends "Authorization: Bearer $CRON_SECRET".
  if (!config.cronSecret || ctx.req.headers.authorization !== `Bearer ${config.cronSecret}`) throw new HttpError(401, 'Unauthorized');
  await sweep();
  return { ok: true };
});

const handler = createHandler({ router, publicDir: path.join(config.root, 'public') });
module.exports = { handler, sweep };
