'use strict';
// Local / VPS server. On Vercel, api/index.js is used instead.
const http = require('node:http');
const config = require('./config');
const { handler, sweep } = require('./app');

const server = http.createServer(handler);
server.listen(config.port, () => {
  console.log(`D24 Studio app running on http://localhost:${config.port}  (staff panel: /admin)`);
  console.log(`Database: ${config.dbUrl ? 'Turso ' + config.dbUrl : config.dbPath}`);
  console.log(`SMS provider: ${config.sms.provider}${config.sms.provider === 'console' ? ' (OTP codes are printed here)' : ''}`);
});

// Reminder sweep: at start-up and every hour (idempotent).
const run = () => sweep().catch((e) => console.error('[reminders]', e));
run();
setInterval(run, 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
