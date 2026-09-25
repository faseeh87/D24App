'use strict';
const http = require('node:http');
const path = require('node:path');
const config = require('./config');
const { Router, createHandler } = require('./http');
const { runReminders } = require('./domain');

const router = new Router();
require('./routes-customer')(router);
require('./routes-admin')(router);
router.get('/api/health', () => ({ ok: true }));

const server = http.createServer(createHandler({ router, publicDir: path.join(config.root, 'public') }));
server.listen(config.port, () => {
  console.log(`D24 Studio app running on http://localhost:${config.port}  (staff panel: /admin)`);
  console.log(`SMS provider: ${config.sms.provider}${config.sms.provider === 'console' ? ' (OTP codes are printed here)' : ''}`);
});

// Reminder sweep: at start-up and every hour (idempotent).
const sweep = () => { try { runReminders(); } catch (e) { console.error('[reminders]', e); } };
sweep();
setInterval(sweep, 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
