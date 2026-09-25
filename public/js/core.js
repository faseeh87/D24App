// Shared helpers for the customer app and the staff panel.

export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}
/** Tagged template that escapes every interpolation unless wrapped in raw(). */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? val(vals[i]) : ''); });
  return raw(out);
}

export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-d24': '1' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data.error || 'Something went wrong');
  return data;
}

// ---------- formatting ----------
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 });
export const money = (paise) => inr.format((paise || 0) / 100);
export const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' }) : '';
export const fmtDay = (s) => fmtDate(s, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtPhone = (p) => (p || '').replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');
export function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}
export function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function relDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
export const kindName = (k) => (k === 'ppf' ? 'Paint protection film' : 'Ceramic coating');
export const kindShort = (k) => (k === 'ppf' ? 'PPF' : 'Ceramic');

// ---------- icons (24px line set) ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m8.8 12 2.2 2.2 4.3-4.4"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4 21c1.2-4.2 4.3-6.3 8-6.3s6.8 2.1 8 6.3"/>',
  bell: '<path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2H4.5z"/><path d="M10 21h4"/>',
  car: '<path d="M3 15.5V13l2-4.5C5.5 7.5 6.3 7 7.4 7h9.2c1.1 0 1.9.5 2.4 1.5L21 13v2.5c0 .6-.4 1-1 1h-1"/><path d="M5 16.5H4c-.6 0-1-.4-1-1"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/><path d="M9.5 16.5h5M4 12.5h16"/>',
  bike: '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16 9 10h5l4.5 6M9 10 7.5 7H5M14 10l-1.5-3h3"/><path d="M11 16h3l-2.5-6"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  phone: '<path d="M5 4h4l1.5 4.5-2.3 1.4a11 11 0 0 0 5.9 5.9l1.4-2.3L20 15v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
  chat: '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 10.5c.5 1.8 1.8 3.1 3.6 3.6l1.2-1.1 1.7.8-.3 1.5c-3.5.3-7-3.2-6.7-6.7l1.5-.3.8 1.7z"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  print: '<path d="M7 9V3.5h10V9"/><rect x="3.5" y="9" width="17" height="8"/><path d="M7 14h10v6.5H7z"/>',
  logout: '<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  wrench: '<path d="M14.5 4.5a4.5 4.5 0 0 0 4.9 6l-8.6 8.6a2.1 2.1 0 0 1-3-3l8.6-8.6a4.5 4.5 0 0 1-1.9-3z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13"/><path d="m3.5 6 8.5 7 8.5-7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  grid: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.9-3.6 3.4-5.5 6.5-5.5s5.6 1.9 6.5 5.5"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.8c2 .7 3.4 2.4 4 5.2"/>',
  tag: '<path d="M3.5 12.5V4h8.5l8.5 8.5-8.5 8.5z"/><circle cx="8" cy="8.5" r="1.3"/>',
};
export const icon = (name, cls = '') =>
  raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);

// ---------- UI helpers ----------
export function toast(msg, bad = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

/** Opens a bottom sheet / modal. Returns {el, close}. */
export function sheet(title, body) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = html`<div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="sheet-head"><h2 class="h-section">${title}</h2>
      <button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body">${body}</div></div>`.s;
  const prev = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  setTimeout(() => bg.querySelector('input,select,textarea,button:not([data-close])')?.focus(), 50);
  return { el: bg, close };
}

/** Wraps an async submit with button spinner + inline error. */
export async function busy(btn, errEl, fn) {
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  btn?.classList.add('loading'); if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.hidden = false; } else toast(e.message, true);
    throw e;
  } finally { btn?.classList.remove('loading'); if (btn) btn.disabled = false; }
}

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

export function serviceChip(s) {
  const map = {
    missed: ['bad', 'Missed'], upcoming: ['warn', 'Due soon'], scheduled: ['dim', 'Scheduled'],
    booked: ['bone', 'Booked'], done: ['ok', 'Done'], skipped: ['dim', 'Skipped'],
  };
  const [c, t] = map[s.state] || ['dim', s.state];
  return html`<span class="chip ${c}">${t}</span>`;
}

export function healthChip(h) {
  const map = { active: ['ok', 'Active'], attention: ['warn', 'Service overdue'], 'at-risk': ['bad', 'At risk'], expired: ['dim', 'Expired'] };
  const [c, t] = map[h] || ['dim', h];
  return html`<span class="chip ${c}">${t}</span>`;
}

export function bookingChip(st) {
  const map = { requested: ['warn', 'Requested'], confirmed: ['ok', 'Confirmed'], completed: ['dim', 'Completed'], cancelled: ['dim', 'Cancelled'] };
  const [c, t] = map[st] || ['dim', st];
  return html`<span class="chip ${c}">${t}</span>`;
}
