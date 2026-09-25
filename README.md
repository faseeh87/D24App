# D24 Studio: customer app

A customer web app for D24 Studio, plus a staff panel for the studio team.

**Customers** sign in with their mobile number and a 6-digit SMS code. Once signed in they can:

- add and edit their cars and motorcycles (Account → My vehicles)
- view and print every invoice (GST split into CGST and SGST)
- view their ceramic coating and PPF warranty certificates: brand, product, coverage, term, certificate number and the inspection schedule
- book a service: pick a vehicle, a service, a date and a time slot (slots have limited capacity), or book a due inspection in one tap
- get notifications for upcoming services, missed service dates, booking updates, new invoices and warranties that are about to expire

**Staff** (`/admin`, PIN sign-in) can:

- create customers and add vehicles
- raise invoices with line items, discount and GST
- issue ceramic or PPF warranties. The inspection dates for the whole term are scheduled automatically.
- confirm, complete or cancel bookings, and mark services done or skipped
- see booking requests, the next 7 days, missed services and services due soon
- manage the brand list (Prismax, Garware and Koch-Chemie to start; add more any time)

The look matches www.d24.studio: the ink, soot and bone palette, brand red and copper accents, Barlow Condensed, Cormorant Garamond and Libre Franklin, and the logos from the site repo.

## Run it

Requires **Node.js 22.13 or newer**. There are no npm dependencies, because it uses Node's built-in HTTP server and SQLite.

```bash
cp .env.example .env               # optional for local development
npm run seed                       # demo customer: mobile 98765 43210
npm start                          # http://localhost:3000   staff: http://localhost:3000/admin
npm test                           # API tests
```

In development, `SMS_PROVIDER=console` prints OTP codes in the server log and shows them on the sign-in screen. The default staff PIN is `240024`. In production both `SESSION_SECRET` and `ADMIN_PIN` are required.

## Deploying on Vercel

The repo is ready for Vercel as it is. The `public/` folder is served as static files, `api/index.js` handles every `/api/*` request, and `vercel.json` sets the Mumbai region (`bom1`), security headers and a daily reminder cron.

Vercel has no permanent disk, so the database is **Turso**, which is SQLite-compatible. Add these environment variables to the Vercel project:

| Variable | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://<db>.turso.io` (set automatically by the Turso Marketplace integration) |
| `TURSO_AUTH_TOKEN` | Turso database token (also set by the integration) |
| `SESSION_SECRET` | long random string |
| `ADMIN_PIN` | staff PIN, 6+ characters |
| `CRON_SECRET` | random string, used by Vercel Cron to call `/api/cron/reminders` |
| `NODEJS_HELPERS` | `0` |
| `OTP_ON_SCREEN` | `true` shows the sign-in code on screen for testing **before** SMS is set up. Remove it before real customers use the app. |

The tables are created automatically on first request. `GET /api/health` reports which database the app is using. Run `npm run test:remote` to test the Turso code path against a local libSQL stand-in.

## Going live

1. **SMS.** Indian SMS needs DLT-registered templates.
   - **MSG91** (recommended in India): set `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY` and `MSG91_OTP_TEMPLATE_ID`. For reminder texts, set `SMS_REMINDERS=true` and `MSG91_REMINDER_TEMPLATE_ID`, pointing at a flow template with one variable called `message`.
   - **Twilio**: set `SMS_PROVIDER=twilio` and `TWILIO_*`.
2. **Hosting.** Any host that runs Node 22 with a persistent disk works: a VPS, Render, Railway or Fly.io. Use the Dockerfile, or run `npm start` behind a reverse proxy that handles HTTPS. Keep `DB_PATH` on a persistent volume and back it up. Serverless hosts such as Vercel won't work, because SQLite needs a disk.
3. **Domain.** For example, `my.d24.studio` pointing at the app. Link to it from the main website's nav as "My account".
4. Set `STUDIO_GSTIN` so it prints on invoices.

## How reminders work

When a warranty is issued, an inspection is scheduled every *N* months for its full term: 6 months for ceramic and 12 for PPF by default, and staff can change this. Every hour, and whenever a customer opens the app, the server does the following:

- **upcoming**: raises a reminder `REMINDER_DAYS` (default 14) before a service is due
- **missed**: flags a service once its date has passed. The warranty shows *Service overdue*, and after `WARRANTY_GRACE_DAYS` it shows *At risk*.
- reminds the customer about confirmed appointments the day before and on the day
- sends a notice 30 days before a warranty ends

Each reminder is sent only once. When `SMS_REMINDERS=true`, reminders and booking confirmations are also sent by SMS.

## Security notes

- OTPs are 6 digits, stored only as an HMAC, and expire after 5 minutes. Each code allows 5 attempts. There is a 30-second resend cooldown, a limit of 5 codes per number per hour, and per-IP limits.
- Sessions are random tokens stored as hashes, in HttpOnly SameSite cookies that are also Secure in production. Customer and staff sessions are kept separate.
- Mutating requests need a custom header and a same-origin check (CSRF). The app sets a strict CSP and other security headers.
- Customers can only read their own records.

## Structure

```
server/   index.js · http.js (router, static, security) · auth.js (OTP, sessions)
          routes-customer.js · routes-admin.js · domain.js (warranty schedule, reminders, slots)
          db.js (schema) · sms.js (console / MSG91 / Twilio) · seed.js
public/   index.html + js/app.js     customer app
          admin/ + js/admin.js       staff panel
          css/app.css · assets/      shared styles and logos
test/     api.test.js
```
