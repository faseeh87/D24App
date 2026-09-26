'use strict';
// Loads .env (if present) without any dependency, then exposes typed config.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const env = process.env;
const production = env.NODE_ENV === 'production';

let secret = env.SESSION_SECRET;
if (!secret) {
  if (production) throw new Error('SESSION_SECRET must be set in production');
  secret = 'dev-only-secret-change-me';
}
if (production && String(env.SUPER_ADMIN_PIN || env.ADMIN_PIN || '').length < 6) {
  throw new Error('SUPER_ADMIN_PIN or ADMIN_PIN (6+ characters) must be set in production');
}

module.exports = {
  root: ROOT,
  production,
  port: Number(env.PORT || 3000),
  dbPath: path.resolve(ROOT, env.DB_PATH || 'data/d24.db'),
  // Turso / libSQL (required on Vercel). The Vercel Marketplace integration sets TURSO_*.
  dbUrl: env.TURSO_DATABASE_URL || env.LIBSQL_URL || env.DATABASE_URL_LIBSQL || '',
  dbToken: env.TURSO_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN || '',
  vercel: !!env.VERCEL,
  cronSecret: env.CRON_SECRET || '',
  // Shows the OTP on screen instead of requiring SMS. For testing before an SMS provider is set up only.
  otpOnScreen: env.OTP_ON_SCREEN === 'true',
  secret,
  // Owner / Super Admin PIN. SUPER_ADMIN_PIN takes precedence; ADMIN_PIN kept for existing setups.
  adminPinHash: crypto.createHash('sha256').update(String(env.SUPER_ADMIN_PIN || env.ADMIN_PIN || '240024')).digest(),
  timezone: env.TZ_NAME || 'Asia/Kolkata',

  sms: {
    provider: (env.SMS_PROVIDER || 'console').toLowerCase(), // console | msg91 | twilio
    reminders: env.SMS_REMINDERS === 'true',
    msg91: {
      authKey: env.MSG91_AUTH_KEY,
      otpTemplateId: env.MSG91_OTP_TEMPLATE_ID,
      reminderTemplateId: env.MSG91_REMINDER_TEMPLATE_ID,
    },
    twilio: { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM },
  },

  otp: { ttlSec: 300, maxAttempts: 5, resendSec: 30, maxPerHour: 5 },
  session: { customerDays: 30, adminHours: 12 },

  reminders: {
    upcomingDays: Number(env.REMINDER_DAYS || 14),
    warrantyGraceDays: Number(env.WARRANTY_GRACE_DAYS || 30),
  },

  booking: {
    slots: (env.BOOKING_SLOTS || '09:30,10:30,11:30,12:30,13:30,14:30,15:30,16:30,17:30,18:30').split(',').map(s => s.trim()),
    // Separate limits per slot for cars and motorcycles.
    slotCapacity: { car: Number(env.SLOT_CAPACITY || 2), bike: Number(env.BIKE_SLOT_CAPACITY || 2) },
    maxDaysAhead: 90,
  },

  gstRate: Number(env.GST_RATE || 18),

  studio: {
    name: 'D24 Studio',
    phone: env.STUDIO_PHONE || '+918762805856',
    whatsapp: env.STUDIO_WHATSAPP || '918762805856',
    email: env.STUDIO_EMAIL || 'info@d24.studio',
    web: 'www.d24.studio',
    gstin: env.STUDIO_GSTIN || '',
    address: env.STUDIO_ADDRESS || 'Opposite Bharath Chicken, Amrithnagar, Pandeshwar, Mangaluru, Karnataka 575001',
    hours: 'Mon–Sat 09:30–19:00 · Sunday by appointment',
    maps: 'https://maps.google.com/?q=D24+Studio+Pandeshwar+Mangaluru',
  },

  // Bookable services by vehicle class. `kinds` lists the classes each one is offered for.
  serviceCatalog: [
    { name: 'Maintenance wash', kinds: ['car'] },
    { name: 'Car wash', kinds: ['car'] },
    { name: 'Bike wash', kinds: ['bike'] },
    { name: 'Ceramic coating inspection', kinds: ['car', 'bike'] },
    { name: 'PPF inspection', kinds: ['car', 'bike'] },
    { name: 'Ceramic coating', kinds: ['car', 'bike'] },
    { name: 'Paint protection film (PPF)', kinds: ['car', 'bike'] },
    { name: 'Paint correction', kinds: ['car'] },
    { name: 'Interior detailing', kinds: ['car'] },
    { name: 'Headlight restoration', kinds: ['car'] },
    { name: 'Engine bay detailing', kinds: ['car'] },
  ],
};
module.exports.services = module.exports.serviceCatalog.map((s) => s.name);
module.exports.servicesFor = (kind) => module.exports.serviceCatalog.filter((s) => s.kinds.includes(kind)).map((s) => s.name);
