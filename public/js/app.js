import {
  html, raw, api, icon, toast, sheet, busy, formData, money, fmtDate, fmtDay, fmtPhone, todayStr, addDays, relDays,
  kindName, kindShort, serviceChip, healthChip, bookingChip,
} from './core.js';

const root = document.getElementById('app');
const S = { me: null, studio: null, services: [], catalog: [], slots: [], unread: 0 };

const TABS = [
  ['home', '#/', 'Home'],
  ['receipt', '#/invoices', 'Invoices'],
  ['shield', '#/warranty', 'Warranty'],
  ['calendar', '#/book', 'Book'],
  ['user', '#/account', 'Account'],
];

// ---------------------------------------------------------------- boot & routing
async function boot() {
  try {
    const st = await api('/api/studio');
    S.studio = st.studio; S.services = st.services; S.catalog = st.catalog || []; S.slots = st.slots;
    S.me = (await api('/api/me')).customer;
  } catch (e) {
    if (e.status === 401) return renderLogin();
    root.innerHTML = html`<div class="wrap" style="padding:80px 0"><p class="lede">We couldn’t reach the studio server. Please refresh in a moment.</p></div>`.s;
    return;
  }
  route();
}

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  if (!S.me) return renderLogin();
  if (!S.me.name) return renderWelcome();
  const { parts, query } = parseHash();
  const [a, b] = parts;
  window.scrollTo(0, 0);
  try {
    if (!a) return await viewHome();
    if (a === 'invoices') return await viewInvoices();
    if (a === 'invoice' && b) return await viewInvoice(b);
    if (a === 'warranty' && b) return await viewWarranty(b);
    if (a === 'warranty') return await viewWarranties();
    if (a === 'book') return await viewBook(query);
    if (a === 'account') return await viewAccount(query);
    if (a === 'notifications') return await viewNotifications();
    location.hash = '#/';
  } catch (e) {
    if (e.status === 401) { S.me = null; return renderLogin(); }
    shell(null, html`<div class="empty"><p class="h-card">Not available</p><p>${e.message}</p><p style="margin-top:14px"><a class="btn sm" href="#/">Back to home</a></p></div>`);
  }
}
window.addEventListener('hashchange', route);
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

// ---------------------------------------------------------------- shell
function shell(active, content) {
  const initial = (S.me?.name || '?').trim().charAt(0).toUpperCase();
  root.innerHTML = html`
  <header class="topbar"><div class="wrap">
    <a class="logo" href="#/" aria-label="D24 Studio home"><img src="/assets/logo-horizontal.png" alt="D24 Studio"></a>
    <nav class="topnav" aria-label="Primary">${TABS.map(([, href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`)}</nav>
    <div class="actions">
      <a class="icon-btn" href="#/notifications" aria-label="Notifications${S.unread ? `, ${S.unread} unread` : ''}">${icon('bell')}${S.unread ? html`<span class="badge">${S.unread > 9 ? '9+' : S.unread}</span>` : ''}</a>
      <a class="avatar" href="#/account" aria-label="Account" title="${S.me?.name || ''}">${initial}</a>
    </div>
  </div></header>
  <main><div class="wrap fade-in">${content}</div></main>
  <nav class="tabbar" aria-label="Primary">${TABS.map(([ic, href, label]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${icon(ic)}<span>${label}</span></a>`)}</nav>`.s;
}

function loading(active) {
  shell(active, html`<div class="stack"><div class="skeleton"></div><div class="skeleton"></div></div>`);
}

function studioFooter() {
  const s = S.studio;
  return html`<div class="footer-note no-print"><span>${s.name} · ${s.address}</span><span>${s.hours}</span></div>`;
}

const vehIcon = (v) => html`<span class="veh-icon">${icon(v?.kind === 'bike' ? 'bike' : 'car')}</span>`;

// ---------------------------------------------------------------- login
function renderLogin() {
  let phone = '';
  let timer = null;
  root.innerHTML = html`
  <div class="auth">
    <aside class="auth-art" aria-hidden="true">
      <img class="m" src="/assets/mark.png" alt="">
      <div class="copy">
        <span class="eyebrow">Client account</span>
        <h1 class="h-display" style="margin-top:18px;font-size:clamp(46px,5vw,74px)">Every detail,<br><span class="serif" style="color:var(--copper)">on record.</span></h1>
        <p class="lede" style="margin-top:18px;max-width:30ch">Invoices, ceramic and PPF warranty certificates, and your next service date. In one place.</p>
      </div>
    </aside>
    <section class="auth-panel"><div class="auth-box">
      <img class="logo" src="/assets/logo-stacked.png" alt="D24 Studio">
      <div id="step"></div>
      <p class="hint" style="margin-top:28px;text-align:center">Need help? Call <a href="tel:${S.studio?.phone || ''}" style="color:var(--copper)">${fmtPhone(S.studio?.phone || '')}</a></p>
    </div></section>
  </div>`.s;
  const step = root.querySelector('#step');

  function phoneStep() {
    clearInterval(timer);
    step.innerHTML = html`
      <span class="eyebrow">Sign in</span>
      <h2 class="h-section" style="margin:12px 0 8px">Your mobile number</h2>
      <p class="muted" style="margin-bottom:24px">We’ll text you a 6-digit code. New here? Signing in creates your account.</p>
      <form id="f" novalidate>
        <label class="field"><span>Mobile number</span>
          <div class="phone-in"><span>+91</span><input class="input" name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="11" placeholder="98765 43210" value="${phone}" required></div>
        </label>
        <p class="error" hidden></p>
        <button class="btn primary block">Send code ${icon('right')}</button>
      </form>`.s;
    const f = step.querySelector('#f');
    f.phone.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      phone = f.phone.value.replace(/\D/g, '').slice(-10);
      const res = await busy(f.querySelector('button'), f.querySelector('.error'), () => api('/api/auth/otp', { method: 'POST', body: { phone } })).catch(() => null);
      if (res) codeStep(res);
    });
  }

  function codeStep(res) {
    step.innerHTML = html`
      <span class="eyebrow">Verify</span>
      <h2 class="h-section" style="margin:12px 0 8px">Enter the code</h2>
      <p class="muted" style="margin-bottom:24px">Sent to <b style="color:var(--bone)">${fmtPhone(res.phone)}</b> · <button class="btn link" id="chg" type="button">Change</button></p>
      <form id="f" novalidate>
        <label class="field"><span>6-digit code</span>
          <input class="input otp-in num" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
        </label>
        <p class="error" hidden></p>
        <button class="btn primary block">Verify &amp; sign in</button>
      </form>
      <p style="margin-top:18px;text-align:center"><button class="btn link" id="resend" type="button" disabled>Resend code</button></p>
      ${res.devCode ? html`<p class="devcode">Development mode: no SMS provider is configured, so your code is <b>${res.devCode}</b>.</p>` : ''}`.s;
    const f = step.querySelector('#f');
    const resend = step.querySelector('#resend');
    f.code.focus();
    step.querySelector('#chg').onclick = phoneStep;
    let left = res.resendIn;
    const tick = () => { resend.disabled = left > 0; resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code'; left--; };
    tick(); clearInterval(timer); timer = setInterval(() => { tick(); if (left < 0) clearInterval(timer); }, 1000);
    resend.onclick = async () => {
      const r = await busy(resend, f.querySelector('.error'), () => api('/api/auth/otp', { method: 'POST', body: { phone } })).catch(() => null);
      if (r) { toast('A new code is on its way'); codeStep(r); }
    };
    const submit = async () => {
      const out = await busy(f.querySelector('button'), f.querySelector('.error'), () => api('/api/auth/verify', { method: 'POST', body: { phone, code: f.code.value } })).catch(() => null);
      if (out) { clearInterval(timer); S.me = out.customer; go(location.hash && location.hash !== '#' ? location.hash : '#/'); }
    };
    f.code.addEventListener('input', () => { f.code.value = f.code.value.replace(/\D/g, '').slice(0, 6); if (f.code.value.length === 6) submit(); });
    f.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }
  phoneStep();
}

// ---------------------------------------------------------------- welcome (first sign-in)
function renderWelcome() {
  root.innerHTML = html`
  <div class="auth"><aside class="auth-art" aria-hidden="true"><img class="m" src="/assets/mark.png" alt="">
    <div class="copy"><span class="eyebrow">Welcome</span><h1 class="h-display" style="margin-top:18px;font-size:clamp(46px,5vw,74px)">Good to<br><span class="serif" style="color:var(--copper)">have you.</span></h1></div></aside>
  <section class="auth-panel"><div class="auth-box">
    <img class="logo" src="/assets/logo-stacked.png" alt="D24 Studio">
    <span class="eyebrow">Your details</span>
    <h2 class="h-section" style="margin:12px 0 24px">Tell us who you are</h2>
    <form id="f" novalidate>
      <label class="field"><span>Full name</span><input class="input" name="name" autocomplete="name" required maxlength="80"></label>
      <label class="field"><span>Email (optional)</span><input class="input" name="email" type="email" autocomplete="email" maxlength="120"></label>
      <label class="field"><span>City (optional)</span><input class="input" name="city" autocomplete="address-level2" value="Mangaluru" maxlength="60"></label>
      <p class="error" hidden></p>
      <button class="btn primary block">Continue ${icon('right')}</button>
    </form>
  </div></section></div>`.s;
  const f = root.querySelector('#f');
  f.name.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await busy(f.querySelector('button'), f.querySelector('.error'), () => api('/api/me', { method: 'PATCH', body: formData(f) })).catch(() => null);
    if (out) { S.me = out.customer; go('#/account?add=vehicle'); }
  });
}

// ---------------------------------------------------------------- home
function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function serviceAlert(s, bad) {
  const v = s.vehicle;
  return html`<div class="alert ${bad ? 'bad' : ''}" role="${bad ? 'alert' : 'status'}">
    ${icon(bad ? 'alert' : 'clock')}
    <div class="grow"><b>${bad ? 'Missed' : 'Due soon'}: ${s.title}</b>
      <p class="muted small" style="margin-top:2px">${v.make} ${v.model} · <span class="plate" style="font-size:11px;padding:1px 6px">${v.reg_no}</span> · ${bad ? 'was due' : 'due'} ${fmtDate(s.due_on)} (${relDays(s.days)})${bad ? '. Book soon to keep your warranty valid.' : ''}</p></div>
    <a class="btn sm ${bad ? 'primary' : ''}" href="#/book?service=${s.id}">Book now</a></div>`;
}

async function viewHome() {
  loading('#/');
  const d = await api('/api/dashboard');
  S.me = d.customer; S.unread = d.unread;
  const first = S.me.name.split(' ')[0];
  const booking = d.bookings[0];
  const next = d.next_service;
  const dueAlerts = d.upcoming.filter((s) => s.status === 'due');

  let hero;
  if (booking) {
    hero = html`<div class="hero-next"><div><span class="label">Your next appointment</span>
        <div class="bigdate" style="margin-top:10px">${fmtDate(booking.date, { day: '2-digit', month: 'short' })}<small>${fmtDate(booking.date, { weekday: 'long' })} · ${booking.slot}</small></div></div>
      <div style="text-align:right"><p class="h-card">${booking.service}</p><p class="muted small">${booking.vehicle_label} · ${bookingChip(booking.status)}</p></div></div>`;
  } else if (next) {
    hero = html`<div class="hero-next"><div><span class="label">Next service</span>
        <div class="bigdate" style="margin-top:10px">${fmtDate(next.due_on, { day: '2-digit', month: 'short' })}<small>${relDays(next.days)}</small></div></div>
      <div style="text-align:right"><p class="h-card">${next.title}</p><p class="muted small" style="margin-bottom:10px">${next.vehicle.make} ${next.vehicle.model}</p>
        ${next.status === 'due' ? html`<a class="btn sm primary" href="#/book?service=${next.id}">Book this service</a>` : serviceChip(next)}</div></div>`;
  } else {
    hero = html`<div class="hero-next"><p class="muted">No services scheduled. Your car’s looking after itself for now.</p><a class="btn sm primary" href="#/book">Book a service</a></div>`;
  }

  shell('#/', html`
    <section class="hero">
      <img class="mark" src="/assets/mark-circle-mono.png" alt="">
      <span class="eyebrow">${fmtDate(todayStr(), { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      <h1 class="h-display" style="margin-top:14px">${greeting()},<br><span class="serif" style="color:var(--copper)">${first}.</span></h1>
      ${hero}
    </section>

    ${d.missed.length || dueAlerts.length ? html`<div class="stack" style="margin-top:16px">${d.missed.map((s) => serviceAlert(s, true))}${dueAlerts.map((s) => serviceAlert(s, false))}</div>` : ''}

    <section class="section">
      <div class="section-head"><h2 class="h-section">Protection</h2><a class="btn link" href="#/warranty">All warranties</a></div>
      ${d.warranties.length ? html`<div class="grid two">${d.warranties.map(warrantyCard)}</div>`
        : html`<div class="empty"><p class="h-card">No warranties yet</p><p>Ceramic coating and PPF certificates appear here after your appointment.</p></div>`}
    </section>

    <div class="grid two section">
      <section>
        <div class="section-head"><h2 class="h-section">Garage</h2><a class="btn link" href="#/account?add=vehicle">Add vehicle</a></div>
        ${d.vehicles.length ? html`<div class="list">${d.vehicles.map((v) => html`<a href="#/account">${vehIcon(v)}<div class="grow"><p class="h-card" style="font-size:17px">${v.make} ${v.model}</p><p class="muted small">${[v.year, v.colour].filter(Boolean).join(' · ')}</p></div><span class="plate">${v.reg_no}</span></a>`)}</div>`
          : html`<div class="empty"><p class="h-card">Add your first vehicle</p><p style="margin-bottom:14px">So we can match invoices and warranties to it.</p><a class="btn sm primary" href="#/account?add=vehicle">${icon('plus')} Add vehicle</a></div>`}
      </section>
      <section>
        <div class="section-head"><h2 class="h-section">Latest invoice</h2><a class="btn link" href="#/invoices">All invoices</a></div>
        ${d.latest_invoice ? invoiceRow(d.latest_invoice, true) : html`<div class="empty"><p>Your invoices will appear here.</p></div>`}
      </section>
    </div>
    ${studioFooter()}`);
}

function warrantyCard(w) {
  return html`<a class="card link" href="#/warranty/${w.id}">
    <div class="card-row" style="align-items:flex-start"><div class="grow">
      <span class="label">${kindName(w.kind)}</span>
      <p class="cert-brand" style="color:var(--bone);font-size:24px;margin-top:6px">${w.brand}</p>
      <p class="muted small">${w.product}</p></div>${healthChip(w.health)}</div>
    <div class="divider"></div>
    <div class="card-row small"><span class="grow">${w.vehicle_label} <span class="plate" style="font-size:11px;padding:1px 6px;margin-left:6px">${w.vehicle.reg_no}</span></span></div>
    <div class="meter ${w.health === 'at-risk' ? 'bad' : ''}" style="margin:14px 0 8px"><i style="width:${w.progress}%"></i></div>
    <div class="card-row small muted"><span class="grow">Valid until ${fmtDate(w.ends_on)}</span><span>${w.health === 'expired' ? 'Expired' : `${w.days_left} days left`}</span></div>
  </a>`;
}

function invoiceRow(i, card = false) {
  const body = html`<div class="grow"><p class="mono">${i.invoice_no}</p><p class="muted small">${fmtDate(i.issued_on)}${i.vehicle_label ? ' · ' + i.vehicle_label : ''}</p></div>
    <div style="text-align:right"><p class="num" style="font-weight:600">${money(i.total)}</p>${i.status === 'paid' ? html`<span class="chip ok">Paid</span>` : html`<span class="chip warn">Due</span>`}</div>${icon('right', 'chev')}`;
  return card ? html`<div class="list"><a href="#/invoice/${i.id}">${body}</a></div>` : html`<a href="#/invoice/${i.id}">${body}</a>`;
}

// ---------------------------------------------------------------- invoices
async function viewInvoices() {
  loading('#/invoices');
  const { invoices } = await api('/api/invoices');
  const spent = invoices.reduce((s, i) => s + i.total, 0);
  shell('#/invoices', html`
    <div class="page-head"><div><span class="eyebrow">Billing</span><h1 class="h-display">Invoices</h1></div>
      ${invoices.length ? html`<p class="muted small">${invoices.length} invoice${invoices.length === 1 ? '' : 's'} · ${money(spent)} total</p>` : ''}</div>
    ${invoices.length ? html`<div class="list">${invoices.map((i) => invoiceRow(i))}</div>`
      : html`<div class="empty"><p class="h-card">No invoices yet</p><p>After your appointment, the invoice for the work done will appear here.</p></div>`}
    ${studioFooter()}`);
}

async function viewInvoice(id) {
  loading('#/invoices');
  const { invoice: i, customer: c, studio: s, warranties } = await api('/api/invoices/' + encodeURIComponent(id));
  const v = i.vehicle;
  shell('#/invoices', html`
    <a class="back" href="#/invoices">${icon('left')} Invoices</a>
    <div class="page-head no-print"><div><span class="eyebrow">Invoice</span><h1 class="h-display mono" style="font-size:clamp(26px,4vw,36px)">${i.invoice_no}</h1></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn sm" id="print">${icon('print')} Print / Save PDF</button>
        <a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${s.whatsapp}?text=${encodeURIComponent(`Hi D24 Studio, I have a question about invoice ${i.invoice_no}.`)}">${icon('chat')} Ask a question</a>
      </div></div>
    <article class="paper">
      <header class="paper-head">
        <div><img src="/assets/logo-horizontal.png" alt="D24 Studio" style="filter:brightness(.85) saturate(1.1)">
          <p class="small" style="margin-top:12px;max-width:34ch;line-height:1.5">${s.address}<br>${fmtPhone(s.phone)} · ${s.email}${s.gstin ? html`<br>GSTIN ${s.gstin}` : ''}</p></div>
        <div class="paper-title">Tax invoice<small class="mono">${i.invoice_no}</small></div>
      </header>
      <div class="paper-meta">
        <div><span class="label">Billed to</span><p style="margin-top:6px"><b>${c.name}</b><br>${fmtPhone(c.phone)}${c.email ? html`<br>${c.email}` : ''}</p></div>
        <div><span class="label">Vehicle</span><p style="margin-top:6px">${v ? html`<b>${v.make} ${v.model}</b><br>${v.reg_no}${v.year ? ` · ${v.year}` : ''}${v.colour ? ` · ${v.colour}` : ''}` : '—'}</p></div>
        <div><span class="label">Date</span><p style="margin-top:6px"><b>${fmtDate(i.issued_on)}</b><br>${i.status === 'paid' ? `Paid${i.payment_mode ? ' via ' + i.payment_mode : ''}` : 'Payment due'}</p></div>
      </div>
      <table>
        <thead><tr><th style="width:36px">#</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
        <tbody>${i.items.map((it, n) => html`<tr><td>${n + 1}</td><td>${it.desc}</td><td class="r num">${it.qty}</td><td class="r num">${money(it.rate)}</td><td class="r num">${money(it.qty * it.rate)}</td></tr>`)}</tbody>
      </table>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px;flex-wrap:wrap">
        <div style="margin-top:22px">${i.status === 'paid' ? html`<span class="stamp">Paid</span>` : html`<span class="stamp due">Due</span>`}</div>
        <div class="totals num">
          <div><span>Subtotal</span><span>${money(i.subtotal)}</span></div>
          ${i.discount ? html`<div><span>Discount</span><span>− ${money(i.discount)}</span></div>` : ''}
          <div><span>CGST ${i.tax_rate / 2}%</span><span>${money(Math.floor(i.tax / 2))}</span></div>
          <div><span>SGST ${i.tax_rate / 2}%</span><span>${money(i.tax - Math.floor(i.tax / 2))}</span></div>
          <div class="grand"><span>Total</span><span>${money(i.total)}</span></div>
        </div>
      </div>
      ${i.notes ? html`<p class="small" style="margin-top:22px"><span class="label">Notes</span><br>${i.notes}</p>` : ''}
      ${warranties.length ? html`<p class="small" style="margin-top:22px"><span class="label">Warranty issued</span><br>${warranties.map((w) => html`${kindName(w.kind)}: ${w.brand} ${w.product} (certificate <span class="mono">${w.cert_no}</span>)<br>`)}</p>` : ''}
      <footer class="paper-foot"><span>Thank you for trusting D24 Studio with your vehicle.</span><span>${s.web}</span></footer>
    </article>
    ${warranties.length ? html`<div class="stack no-print" style="margin-top:16px">${warranties.map((w) => html`<a class="card link card-row" href="#/warranty/${w.id}">${icon('shield', 'chev')}<span class="grow">View ${kindShort(w.kind)} warranty certificate · <span class="mono">${w.cert_no}</span></span>${icon('right', 'chev')}</a>`)}</div>` : ''}
  `);
  root.querySelector('#print').onclick = () => window.print();
}

// ---------------------------------------------------------------- warranties
async function viewWarranties() {
  loading('#/warranty');
  const { warranties } = await api('/api/warranties');
  const kinds = [['ceramic', 'Ceramic coating'], ['ppf', 'Paint protection film']];
  shell('#/warranty', html`
    <div class="page-head"><div><span class="eyebrow">Protection</span><h1 class="h-display">Warranty</h1></div></div>
    <p class="lede" style="margin:-8px 0 28px;max-width:52ch">Keep up your periodic inspections at the studio and your coating and film stay covered for the full term.</p>
    ${warranties.length ? kinds.map(([k, label]) => {
      const list = warranties.filter((w) => w.kind === k);
      return list.length ? html`<section style="margin-bottom:32px"><div class="section-head"><h2 class="h-section">${label}</h2><span class="muted small">${list.length}</span></div><div class="grid two">${list.map(warrantyCard)}</div></section>` : '';
    }) : html`<div class="empty"><p class="h-card">No warranties yet</p><p>When we apply ceramic coating or PPF to your vehicle, the warranty certificate appears here.</p></div>`}
    ${studioFooter()}`);
}

async function viewWarranty(id) {
  loading('#/warranty');
  const { warranty: w, invoice, customer: c } = await api('/api/warranties/' + encodeURIComponent(id));
  const v = w.vehicle;
  const next = w.next_service;
  shell('#/warranty', html`
    <a class="back" href="#/warranty">${icon('left')} Warranty</a>
    <div class="page-head no-print"><div><span class="eyebrow">${kindName(w.kind)}</span><h1 class="h-display">${w.brand}</h1></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${healthChip(w.health)}<button class="btn sm" id="print">${icon('print')} Print certificate</button></div></div>
    ${w.health === 'attention' || w.health === 'at-risk' ? html`<div class="alert bad no-print" style="margin-bottom:16px">${icon('alert')}<div class="grow"><b>${w.health === 'at-risk' ? 'Your warranty is at risk' : 'A check-up is overdue'}</b><p class="muted small">Book the missed inspection so your coverage stays valid.</p></div>${next ? html`<a class="btn sm primary" href="#/book?service=${next.id}">Book now</a>` : ''}</div>` : ''}
    <div class="grid side">
      <article class="paper"><div class="cert">
        <div class="cert-center">
          <img src="/assets/logo-stacked.png" alt="D24 Studio" style="filter:brightness(.85) saturate(1.1)">
          <span class="label">Certificate of warranty</span>
          <h2 style="margin-top:10px">${kindName(w.kind)}</h2>
          <p class="serif" style="margin-top:8px">awarded to ${c.name}</p>
        </div>
        <div class="cert-grid">
          <div><span class="label">Brand</span><p class="cert-brand" style="font-size:22px">${w.brand}</p></div>
          <div><span class="label">Product</span><p>${w.product}</p></div>
          <div><span class="label">Certificate no.</span><p class="mono">${w.cert_no}</p></div>
          <div><span class="label">Vehicle</span><p>${v.make} ${v.model}<br><span class="muted">${v.reg_no}</span></p></div>
          <div><span class="label">Applied on</span><p>${fmtDate(w.starts_on)}</p></div>
          <div><span class="label">Valid until</span><p>${fmtDate(w.ends_on)}</p></div>
          ${w.coverage ? html`<div style="grid-column:1/-1"><span class="label">Coverage</span><p>${w.coverage}</p></div>` : ''}
        </div>
        <p class="small" style="line-height:1.55"><span class="label">Terms</span><br>${w.terms}</p>
        <p class="small muted" style="margin-top:12px">Inspection every ${w.interval_months} months at D24 Studio.${invoice ? html` Issued against invoice <span class="mono">${invoice.invoice_no}</span>.` : ''}</p>
      </div></article>

      <aside class="stack no-print">
        <div class="card">
          <span class="label">Term</span>
          <div class="meter ${w.health === 'at-risk' ? 'bad' : ''}" style="margin:14px 0 8px"><i style="width:${w.progress}%"></i></div>
          <div class="card-row small muted"><span class="grow">${fmtDate(w.starts_on)}</span><span>${fmtDate(w.ends_on)}</span></div>
          <p style="margin-top:12px">${w.health === 'expired' ? 'This warranty has ended.' : html`<b class="num">${w.days_left}</b> <span class="muted">days of cover remaining</span>`}</p>
        </div>
        <div class="card">
          <div class="section-head" style="margin-bottom:16px"><h3 class="h-card">Service schedule</h3></div>
          ${w.services.length ? html`<ol class="timeline">${w.services.map((s) => html`<li class="${s.state}"><div><p style="font-weight:500">${fmtDate(s.due_on)}</p><p class="muted small">${s.title}${s.done_on ? ` · done ${fmtDate(s.done_on)}` : ''}</p></div>
            <div style="display:flex;gap:8px;align-items:center">${serviceChip(s)}${s.status === 'due' && (s.state === 'missed' || s.state === 'upcoming') ? html`<a class="btn sm" href="#/book?service=${s.id}">Book</a>` : ''}</div></li>`)}</ol>`
            : html`<p class="muted small">No periodic services for this warranty.</p>`}
        </div>
        ${invoice ? html`<a class="card link card-row" href="#/invoice/${invoice.id}">${icon('receipt', 'chev')}<span class="grow">Invoice <span class="mono">${invoice.invoice_no}</span></span>${icon('right', 'chev')}</a>` : ''}
      </aside>
    </div>`);
  root.querySelector('#print').onclick = () => window.print();
}

// ---------------------------------------------------------------- booking
async function viewBook(query) {
  loading('#/book');
  const [{ vehicles }, { services }, { bookings }] = await Promise.all([api('/api/vehicles'), api('/api/services'), api('/api/bookings')]);
  const t = todayStr();
  const upcomingB = bookings.filter((b) => ['requested', 'confirmed'].includes(b.status) && b.date >= t).sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  const pastB = bookings.filter((b) => !upcomingB.includes(b));
  const dueServices = services.filter((s) => s.status === 'due' && (s.state === 'missed' || s.state === 'upcoming' || String(s.id) === query.service));

  const st = { vehicle_id: vehicles[0]?.id, service: '', date: '', slot: '', service_id: null };
  const linked = query.service ? dueServices.find((s) => String(s.id) === query.service) : null;
  if (linked) Object.assign(st, { vehicle_id: linked.vehicle_id, service: S.services.includes(linked.title) ? linked.title : '', service_id: linked.id });

  const days = [];
  for (let i = 1; days.length < 21; i++) days.push(addDays(t, i));

  shell('#/book', html`
    <div class="page-head"><div><span class="eyebrow">Appointments</span><h1 class="h-display">Book a service</h1></div></div>
    ${!vehicles.length ? html`<div class="empty"><p class="h-card">Add a vehicle first</p><p style="margin-bottom:14px">Tell us what you drive, then pick a slot.</p><a class="btn sm primary" href="#/account?add=vehicle">${icon('plus')} Add vehicle</a></div>` : html`
    <div class="grid side">
      <form id="bf" class="card pad-lg" novalidate>
        ${dueServices.length ? html`<div class="field"><span>Due for service</span><div class="stack" id="due">${dueServices.map((s) => html`
          <button type="button" class="choice card-row" data-due="${s.id}" aria-pressed="${st.service_id === s.id}" style="text-align:left;width:100%">
            <span class="grow"><b style="font-weight:600">${s.title}</b><br><span class="small" style="opacity:.75">${s.make} ${s.model} · ${fmtDate(s.due_on)}</span></span>${serviceChip(s)}</button>`)}</div></div>` : ''}
        <div class="field"><span>Vehicle</span><div class="choices" id="veh">${vehicles.map((v) => html`<button type="button" class="choice" data-veh="${v.id}" aria-pressed="${st.vehicle_id === v.id}">${v.make} ${v.model} · ${v.reg_no}</button>`)}</div></div>
        <div class="field"><span id="svc-label">Service</span><div class="choices" id="svc"></div></div>
        <div class="field"><span>Date</span>
          <div class="days" id="days">${days.map((d) => { const sun = new Date(d + 'T00:00:00Z').getUTCDay() === 0; return html`<button type="button" class="day" data-day="${d}" aria-pressed="false" ${sun ? raw('disabled title="Sundays by appointment: please call"') : ''}><small>${fmtDate(d, { weekday: 'short' })}</small><b>${fmtDate(d, { day: 'numeric' })}</b><small>${fmtDate(d, { month: 'short' })}</small></button>`; })}</div>
          <label class="hint" style="display:flex;gap:10px;align-items:center;margin-top:6px">Later date <input class="input" type="date" id="later" min="${addDays(t, 22)}" max="${addDays(t, 90)}" style="max-width:190px;min-height:40px;padding:6px 10px;font-size:14px"></label>
        </div>
        <div class="field"><span>Time</span><div id="slots" class="hint">Pick a date to see open slots.</div></div>
        <label class="field"><span>Notes (optional)</span><textarea class="input" name="notes" maxlength="500" placeholder="Anything we should know? Pick-up, specific panels, concerns…"></textarea></label>
        <p class="error" hidden></p>
        <button class="btn primary block" id="submit">Request booking</button>
        <p class="hint" style="margin-top:12px;text-align:center">We’ll confirm your slot by notification and SMS.</p>
      </form>
      <aside class="stack">
        <div class="section-head" style="margin-bottom:0"><h2 class="h-card">Your bookings</h2></div>
        ${upcomingB.length ? upcomingB.map(bookingCard) : html`<div class="empty small">No upcoming bookings.</div>`}
        ${pastB.length ? html`<details class="card"><summary class="label" style="cursor:pointer">Past &amp; cancelled (${pastB.length})</summary>
          <div class="stack" style="margin-top:14px">${pastB.map((b) => html`<div class="card-row small"><span class="grow">${fmtDate(b.date)} · ${b.service}<br><span class="muted">${b.vehicle_label}</span></span>${bookingChip(b.status)}</div>`)}</div></details>` : ''}
        <div class="card small"><p class="label" style="margin-bottom:8px">Prefer to talk?</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn sm" href="tel:${S.studio.phone}">${icon('phone')} Call</a><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${S.studio.whatsapp}">${icon('chat')} WhatsApp</a></div></div>
      </aside>
    </div>`}`);

  if (!vehicles.length) return;
  const f = root.querySelector('#bf');
  // Service options follow the class (car / motorcycle) of the selected vehicle.
  const kindOf = (id) => vehicles.find((v) => v.id === id)?.kind || 'car';
  const servicesFor = (kind) => S.catalog.filter((c) => c.kinds.includes(kind)).map((c) => c.name);
  function renderServices() {
    const kind = kindOf(st.vehicle_id);
    const list = servicesFor(kind);
    if (st.service && !list.includes(st.service)) st.service = '';
    root.querySelector('#svc-label').textContent = kind === 'bike' ? 'Service · motorcycle' : 'Service · car';
    root.querySelector('#svc').innerHTML = list.map((s) => html`<button type="button" class="choice" data-svc="${s}" aria-pressed="${st.service === s}">${s}</button>`.s).join('');
  }
  renderServices();
  const press = (sel, attr, value) => root.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));

  async function loadSlots() {
    const box = root.querySelector('#slots');
    if (!st.date) return;
    box.innerHTML = '<span class="hint">Checking availability…</span>';
    const r = await api('/api/slots?date=' + st.date);
    if (r.closed || !r.slots.length) { box.innerHTML = html`<span class="hint">Closed on this day. Sundays are by appointment: please call us.</span>`.s; return; }
    if (!r.slots.find((s) => s.slot === st.slot && s.available)) st.slot = '';
    box.className = 'slots';
    box.innerHTML = r.slots.map((s) => html`<button type="button" class="slot" data-slot="${s.slot}" aria-pressed="${st.slot === s.slot}" ${s.available ? '' : raw('disabled')}><b>${s.slot}</b><small>${s.available ? `${s.left} open` : 'Full'}</small></button>`.s).join('');
  }

  f.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.due) {
      const s = dueServices.find((x) => String(x.id) === b.dataset.due);
      const on = st.service_id !== s.id;
      st.service_id = on ? s.id : null;
      if (on) { st.vehicle_id = s.vehicle_id; if (S.services.includes(s.title)) st.service = s.title; }
      press('[data-due]', 'due', st.service_id); press('[data-veh]', 'veh', st.vehicle_id); renderServices();
    } else if (b.dataset.veh) {
      st.vehicle_id = Number(b.dataset.veh); press('[data-veh]', 'veh', st.vehicle_id); renderServices();
      const s = dueServices.find((x) => x.id === st.service_id);
      if (s && s.vehicle_id !== st.vehicle_id) { st.service_id = null; press('[data-due]', 'due', null); }
    } else if (b.dataset.svc) {
      st.service = b.dataset.svc; press('[data-svc]', 'svc', st.service);
    } else if (b.dataset.day) {
      st.date = b.dataset.day; press('[data-day]', 'day', st.date); root.querySelector('#later').value = ''; loadSlots();
    } else if (b.dataset.slot) {
      st.slot = b.dataset.slot; press('[data-slot]', 'slot', st.slot);
    }
  });
  root.querySelector('#later').addEventListener('change', (e) => { st.date = e.target.value; press('[data-day]', 'day', ''); loadSlots(); });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = f.querySelector('.error');
    const missing = !st.service ? 'Choose a service' : !st.date ? 'Choose a date' : !st.slot ? 'Choose a time slot' : '';
    if (missing) { err.textContent = missing; err.hidden = false; return; }
    const out = await busy(f.querySelector('#submit'), err, () => api('/api/bookings', { method: 'POST', body: { ...st, notes: f.notes.value } })).catch(() => null);
    if (out) { toast('Booking requested. We’ll confirm shortly.'); go('#/book'); }
  });
  if (linked) root.querySelector('#days')?.scrollIntoView({ block: 'nearest' });
}

function bookingCard(b) {
  return html`<div class="card"><div class="card-row" style="align-items:flex-start">
    <div class="grow"><p class="h-card" style="font-size:17px">${fmtDay(b.date)} · ${b.slot}</p><p class="small">${b.service}</p><p class="muted small">${b.vehicle_label} · ${b.vehicle.reg_no}</p></div>
    ${bookingChip(b.status)}</div>
    <div style="margin-top:12px"><button class="btn sm danger" data-cancel="${b.id}">Cancel booking</button></div></div>`;
}

document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-cancel]');
  if (!c) return;
  if (!confirm('Cancel this booking?')) return;
  await busy(c, null, () => api(`/api/bookings/${c.dataset.cancel}/cancel`, { method: 'POST' })).catch(() => null);
  toast('Booking cancelled');
  viewBook({});
});

// ---------------------------------------------------------------- account
function vehicleForm(v = {}) {
  const y = new Date().getFullYear();
  return html`<form id="vf" novalidate>
    <div class="field"><span>Type</span><div class="seg">
      <label><input type="radio" name="kind" value="car" ${v.kind !== 'bike' ? raw('checked') : ''}><span>Car</span></label>
      <label><input type="radio" name="kind" value="bike" ${v.kind === 'bike' ? raw('checked') : ''}><span>Motorcycle</span></label></div></div>
    <div class="row two">
      <label class="field"><span>Make</span><input class="input" name="make" required maxlength="40" placeholder="e.g. Mercedes-Benz" value="${v.make || ''}"></label>
      <label class="field"><span>Model</span><input class="input" name="model" required maxlength="60" placeholder="e.g. C 300" value="${v.model || ''}"></label>
    </div>
    <label class="field"><span>Registration number</span><input class="input" name="reg_no" required maxlength="15" placeholder="KA 19 MN 2424" style="text-transform:uppercase" value="${v.reg_no || ''}"></label>
    <div class="row two">
      <label class="field"><span>Year</span><input class="input" name="year" inputmode="numeric" maxlength="4" placeholder="${y}" value="${v.year || ''}"></label>
      <label class="field"><span>Colour</span><input class="input" name="colour" maxlength="30" placeholder="e.g. Obsidian Black" value="${v.colour || ''}"></label>
    </div>
    <label class="field"><span>VIN / chassis no. (optional)</span><input class="input" name="vin" maxlength="20" value="${v.vin || ''}"></label>
    <p class="error" hidden></p>
    <button class="btn primary block">${v.id ? 'Save changes' : 'Add vehicle'}</button>
  </form>`;
}

function openVehicleSheet(v, done) {
  const sh = sheet(v?.id ? 'Edit vehicle' : 'Add a vehicle', vehicleForm(v || {}));
  const f = sh.el.querySelector('#vf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = formData(f);
    const out = await busy(f.querySelector('button.primary'), f.querySelector('.error'),
      () => api(v?.id ? `/api/vehicles/${v.id}` : '/api/vehicles', { method: v?.id ? 'PATCH' : 'POST', body })).catch(() => null);
    if (out) { sh.close(); toast(v?.id ? 'Vehicle updated' : 'Vehicle added to your garage'); done(); }
  });
}

async function viewAccount(query) {
  loading('#/account');
  const { vehicles } = await api('/api/vehicles');
  const c = S.me; const s = S.studio;
  shell('#/account', html`
    <div class="page-head"><div><span class="eyebrow">Account</span><h1 class="h-display">${c.name}</h1></div></div>
    <div class="grid side">
      <div>
        <div class="section-head"><h2 class="h-section">My vehicles</h2><button class="btn sm" id="addv">${icon('plus')} Add vehicle</button></div>
        ${vehicles.length ? html`<div class="list">${vehicles.map((v) => html`<div>${vehIcon(v)}
          <div class="grow"><p class="h-card" style="font-size:17px">${v.make} ${v.model}</p>
            <p class="muted small">${v.kind === 'bike' ? 'Motorcycle' : 'Car'}${v.year ? ` · ${v.year}` : ''}${v.colour ? ` · ${v.colour}` : ''}</p>
            <p style="margin-top:6px"><span class="plate">${v.reg_no}</span></p></div>
          <div style="display:flex;gap:6px"><button class="icon-btn" data-editv="${v.id}" aria-label="Edit ${v.make} ${v.model}">${icon('edit')}</button>
          <button class="icon-btn" data-delv="${v.id}" aria-label="Remove ${v.make} ${v.model}">${icon('x')}</button></div></div>`)}</div>`
          : html`<div class="empty"><p class="h-card">No vehicles yet</p><p>Add your car or motorcycle to book services and see its records.</p></div>`}
      </div>
      <aside class="stack">
        <div class="card">
          <div class="card-row" style="margin-bottom:14px"><h2 class="h-card grow">Profile</h2><button class="btn sm" id="editp">${icon('edit')} Edit</button></div>
          <dl class="kv"><dt>Name</dt><dd>${c.name}</dd><dt>Mobile</dt><dd class="num">${fmtPhone(c.phone)}</dd><dt>Email</dt><dd>${c.email || '—'}</dd><dt>City</dt><dd>${c.city || '—'}</dd></dl>
        </div>
        <div class="card">
          <h2 class="h-card" style="margin-bottom:12px">The studio</h2>
          <p class="small muted" style="margin-bottom:4px">${s.address}</p>
          <p class="small muted" style="margin-bottom:14px">${s.hours}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a class="btn sm" href="tel:${s.phone}">${icon('phone')} Call</a>
            <a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${s.whatsapp}">${icon('chat')} WhatsApp</a>
            <a class="btn sm" target="_blank" rel="noopener" href="${s.maps}">${icon('pin')} Directions</a>
          </div>
        </div>
        <button class="btn block danger" id="logout">${icon('logout')} Sign out</button>
      </aside>
    </div>
    ${studioFooter()}`);

  const refresh = () => viewAccount({});
  root.querySelector('#addv').onclick = () => openVehicleSheet(null, refresh);
  root.querySelectorAll('[data-editv]').forEach((b) => { b.onclick = () => openVehicleSheet(vehicles.find((v) => String(v.id) === b.dataset.editv), refresh); });
  root.querySelectorAll('[data-delv]').forEach((b) => {
    b.onclick = async () => {
      const v = vehicles.find((x) => String(x.id) === b.dataset.delv);
      if (!confirm(`Remove ${v.make} ${v.model} (${v.reg_no}) from your garage?`)) return;
      const ok = await busy(b, null, () => api(`/api/vehicles/${v.id}`, { method: 'DELETE' })).catch(() => null);
      if (ok) { toast('Vehicle removed'); refresh(); }
    };
  });
  root.querySelector('#editp').onclick = () => {
    const sh = sheet('Edit profile', html`<form id="pf" novalidate>
      <label class="field"><span>Full name</span><input class="input" name="name" required maxlength="80" value="${c.name}"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" maxlength="120" value="${c.email || ''}"></label>
      <label class="field"><span>City</span><input class="input" name="city" maxlength="60" value="${c.city || ''}"></label>
      <p class="hint" style="margin-bottom:16px">Your mobile number is your sign-in. To change it, contact the studio.</p>
      <p class="error" hidden></p><button class="btn primary block">Save</button></form>`);
    const f = sh.el.querySelector('#pf');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = await busy(f.querySelector('button.primary'), f.querySelector('.error'), () => api('/api/me', { method: 'PATCH', body: formData(f) })).catch(() => null);
      if (out) { S.me = out.customer; sh.close(); toast('Profile saved'); refresh(); }
    });
  };
  root.querySelector('#logout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
    S.me = null; S.unread = 0; go('#/');
  };
  if (query.add === 'vehicle') {
    history.replaceState(null, '', '#/account');
    openVehicleSheet(null, refresh);
  }
}

// ---------------------------------------------------------------- notifications
const NICON = { missed: 'alert', upcoming: 'clock', booking: 'calendar', warranty: 'shield', invoice: 'receipt' };
async function viewNotifications() {
  loading(null);
  const { notifications } = await api('/api/notifications');
  const unreadIds = notifications.filter((n) => !n.read_at).map((n) => n.id);
  S.unread = unreadIds.length;
  shell(null, html`
    <div class="page-head"><div><span class="eyebrow">Inbox</span><h1 class="h-display">Notifications</h1></div>
      ${unreadIds.length ? html`<span class="muted small">${unreadIds.length} new</span>` : ''}</div>
    ${notifications.length ? html`<div class="list" style="display:block">${notifications.map((n) => html`
      <a class="notif k-${n.kind} ${n.read_at ? '' : 'unread'}" href="${n.link || '#/'}">
        <span class="ico">${icon(NICON[n.kind] || 'bell')}</span>
        <span class="grow" style="flex:1"><b style="font-weight:600">${n.title}</b>${n.body ? html`<p class="muted small" style="margin-top:2px">${n.body}</p>` : ''}
          <p class="label" style="margin-top:6px;font-size:10px">${new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</p></span>
        <span class="dot"></span></a>`)}</div>`
      : html`<div class="empty"><p class="h-card">All caught up</p><p>Service reminders and booking updates will appear here.</p></div>`}`);
  if (unreadIds.length) { api('/api/notifications/read', { method: 'POST', body: {} }).catch(() => null); S.unread = 0; }
}

// Keep the bell badge fresh while the app is open; surface a browser notification if allowed.
setInterval(async () => {
  if (!S.me || document.hidden) return;
  try {
    const { notifications } = await api('/api/notifications?fresh=0');
    const n = notifications.filter((x) => !x.read_at).length;
    if (n !== S.unread) {
      S.unread = n;
      const bell = root.querySelector('.topbar a[href="#/notifications"]');
      if (bell) bell.innerHTML = html`${icon('bell')}${n ? html`<span class="badge">${n > 9 ? '9+' : n}</span>` : ''}`.s;
    }
  } catch { /* offline */ }
}, 60000);

boot();
