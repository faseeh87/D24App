'use strict';
// Pluggable SMS delivery. Providers: console (development), msg91, twilio.
// Indian SMS requires DLT-registered templates; with MSG91 put the approved
// template IDs in .env (see README).
const config = require('./config');

const log = (...a) => console.log('[sms]', ...a);

async function msg91Otp(phone, code) {
  const { authKey, otpTemplateId } = config.sms.msg91;
  if (!authKey || !otpTemplateId) throw new Error('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required');
  const url = new URL('https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', otpTemplateId);
  url.searchParams.set('mobile', phone.replace('+', ''));
  url.searchParams.set('otp', code);
  const res = await fetch(url, { method: 'POST', headers: { authkey: authKey, 'content-type': 'application/json' }, body: '{}' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.type === 'error') throw new Error('MSG91 OTP failed: ' + (body.message || res.status));
}

async function msg91Message(phone, text) {
  const { authKey, reminderTemplateId } = config.sms.msg91;
  if (!authKey || !reminderTemplateId) return log('MSG91 reminder template not configured, skipped', phone);
  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: authKey, 'content-type': 'application/json' },
    body: JSON.stringify({ template_id: reminderTemplateId, recipients: [{ mobiles: phone.replace('+', ''), message: text }] }),
  });
  if (!res.ok) throw new Error('MSG91 flow failed: ' + res.status);
}

async function twilioSend(phone, text) {
  const { sid, token, from } = config.sms.twilio;
  if (!sid || !token || !from) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are required');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: phone, From: from, Body: text }),
  });
  if (!res.ok) throw new Error('Twilio failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

async function sendOtp(phone, code) {
  const p = config.sms.provider;
  if (p === 'msg91') return msg91Otp(phone, code);
  if (p === 'twilio') return twilioSend(phone, `${code} is your D24 Studio login code. It expires in 5 minutes. Do not share it.`);
  log(`OTP for ${phone}: ${code}`);
}

async function sendMessage(phone, text) {
  const p = config.sms.provider;
  if (p === 'msg91') return msg91Message(phone, text);
  if (p === 'twilio') return twilioSend(phone, text);
  log(`to ${phone}: ${text}`);
}

module.exports = { sendOtp, sendMessage, isDevProvider: () => config.sms.provider === 'console' };
