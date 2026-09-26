import {
  html, raw, api, icon, toast, sheet, busy, formData, money, fmtDate, fmtPhone, todayStr, relDays,
  kindName, serviceChip, healthChip, bookingChip,
} from './core.js';

const root = document.getElementById('app');
const A = { staff: null, services: [], catalog: [], gstRate: 18, brands: [], categories: [], unread: 0 };
const isSuper = () => A.staff?.role === 'super';

const NAV = () => [
  ['#/', 'Overview'], ['#/customers', 'Customers'], ['#/bookings', 'Bookings'], ['#/inventory', 'Inventory'],
  ...(isSuper() ? [['#/finance', 'Finance'], ['#/approvals', 'Approvals'], ['#/marketing', 'Marketing'], ['#/settings', 'Settings']] : []),
];

async function boot() {
  try {
    const s = await api('/api/admin/session');
    Object.assign(A, { staff: s.staff, services: s.services, catalog: s.catalog, gstRate: s.gstRate, categories: s.categories, unread: s.unread });
  } catch (e) {
    if (e.status === 401) return renderLogin();
    root.innerHTML = '<p style="padding:40px">Server unavailable.</p>';
    return;
  }
  route();
}

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
async function route() {
  const h = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const [a, b] = h.split('/').filter(Boolean);
  document.querySelectorAll('.sheet-bg').forEach((el) => el.remove()); // close any open dialog on navigation
  window.scrollTo(0, 0);
  try {
    if (!a) return await viewOverview();
    if (a === 'customers') return await viewCustomers();
    if (a === 'customer' && b) return await viewCustomer(b);
    if (a === 'bookings') return await viewBookings();
    if (a === 'inventory') return await viewInventory();
    if (a === 'notifications') return await viewNotifications();
    if (isSuper()) {
      if (a === 'finance') return await viewFinance();
      if (a === 'approvals') return await viewApprovals();
      if (a === 'marketing') return await viewMarketing();
      if (a === 'settings' || a === 'staff') return await viewSettings();
    }
    go('#/');
  } catch (e) {
    if (e.status === 401) return renderLogin();
    shell(null, html`<div class="empty">${e.message}</div>`);
  }
}
window.addEventListener('hashchange', route);

function shell(active, content) {
  root.innerHTML = html`
  <header class="topbar"><div class="wrap">
    <a class="logo" href="#/"><img src="/assets/logo-horizontal.png" alt="D24 Studio"></a>
    <span class="label role-tag">${isSuper() ? 'Super Admin' : 'Admin'}</span>
    <nav class="topnav admin-nav">${NAV().map(([href, l]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${l}</a>`)}</nav>
    <div class="actions">
      <a class="icon-btn" href="#/notifications" aria-label="Alerts${A.unread ? `, ${A.unread} new` : ''}" title="Alerts">${icon('bell')}${A.unread ? html`<span class="badge">${A.unread > 9 ? '9+' : A.unread}</span>` : ''}</a>
      <button class="icon-btn" id="out" aria-label="Sign out" title="Sign out (${A.staff?.name || ''})">${icon('logout')}</button>
    </div>
  </div></header>
  <main style="padding-bottom:64px"><div class="wrap fade-in">${content}</div></main>`.s;
  root.querySelector('#out').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); A.staff = null; renderLogin(); };
}

function renderLogin() {
  root.innerHTML = html`<div class="auth"><aside class="auth-art" aria-hidden="true"><img class="m" src="/assets/mark.png" alt="">
    <div class="copy"><span class="eyebrow">Studio</span><h1 class="h-display" style="margin-top:18px;font-size:clamp(46px,5vw,74px)">Staff<br><span class="serif" style="color:var(--copper)">console.</span></h1></div></aside>
    <section class="auth-panel"><div class="auth-box"><img class="logo" src="/assets/logo-stacked.png" alt="D24 Studio">
      <span class="eyebrow">Staff sign-in</span><h2 class="h-section" style="margin:12px 0 24px">Enter your PIN</h2>
      <form id="f"><label class="field"><span>Staff PIN</span><input class="input otp-in" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
      <p class="error" hidden></p><button class="btn primary block">Sign in</button></form></div></section></div>`.s;
  const f = root.querySelector('#f');
  f.pin.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await busy(f.querySelector('button'), f.querySelector('.error'), () => api('/api/admin/login', { method: 'POST', body: { pin: f.pin.value } })).catch(() => null);
    if (ok) { location.hash = '#/'; boot(); }
  });
}

// ---------------------------------------------------------------- helpers
const who = (r) => html`<b style="font-weight:600">${r.customer_name || 'Unnamed'}</b><br><span class="muted small num">${fmtPhone(r.customer_phone)}</span>`;
const payChip = (i) => ({ paid: html`<span class="chip ok">Paid</span>`, partial: html`<span class="chip warn">Part paid</span>`, unpaid: html`<span class="chip bad">Unpaid</span>` }[i.payment_status || (i.amount_paid >= i.total ? 'paid' : i.amount_paid > 0 ? 'partial' : 'unpaid')]);
const qty = (n, unit) => `${Math.round(n * 100) / 100} ${unit}`;
const table = (heads, rows, empty) => (rows.length
  ? html`<div class="table-wrap"><table class="t"><thead><tr>${heads.map((h) => html`<th>${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`
  : html`<div class="empty small">${empty}</div>`);
function bindRowLinks() {
  root.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) location.hash = tr.dataset.href; }));
}

function bookingActions(b) {
  const acts = { requested: [['confirmed', 'Confirm', 'primary'], ['cancelled', 'Decline', 'danger']], confirmed: [['completed', 'Complete', 'primary'], ['cancelled', 'Cancel', 'danger']] }[b.status] || [];
  return html`<div style="display:flex;gap:6px;justify-content:flex-end">${acts.map(([st, l, c]) => html`<button class="btn sm ${c}" data-bk="${b.id}" data-st="${st}">${l}</button>`)}</div>`;
}

/** Complete a booking: staff pick which product was used for each tracked category. */
async function completeBooking(id) {
  const { usage } = await api(`/api/admin/bookings/${id}/usage`);
  const doIt = (picks) => api(`/api/admin/bookings/${id}/status`, { method: 'POST', body: { status: 'completed', picks } });
  if (!usage.length) { await doIt({}); toast('Booking completed'); return route(); }
  const sh = sheet('Complete job', html`<form novalidate>
    <p class="muted" style="margin-bottom:16px">Pick the product used. The standard amount is deducted from stock.</p>
    ${usage.map((u) => html`<label class="field"><span>${u.category} · ${qty(u.amount, u.unit)}</span>
      <select class="input" name="${u.category}">${u.items.map((i) => html`<option value="${i.id}" ${i.quantity < u.amount ? raw('disabled') : ''}>${i.brand} ${i.sub_brand} (${qty(i.quantity, i.unit)} left)</option>`)}</select></label>`)}
    <p class="error" hidden></p><button class="btn primary block">Complete &amp; deduct stock</button></form>`);
  const f = sh.el.querySelector('form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => doIt(formData(f))).catch(() => null);
    if (ok) { sh.close(); toast('Booking completed, stock updated'); route(); }
  });
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-bk],[data-svc-st]');
  if (!b) return;
  if (b.dataset.bk) {
    if (b.dataset.st === 'completed') return completeBooking(b.dataset.bk).catch((er) => toast(er.message, true));
    if (b.dataset.st === 'cancelled' && !confirm('Cancel this booking? The customer will be notified.')) return;
    const ok = await busy(b, null, () => api(`/api/admin/bookings/${b.dataset.bk}/status`, { method: 'POST', body: { status: b.dataset.st } })).catch(() => null);
    if (ok) toast('Booking ' + b.dataset.st);
  } else if (b.dataset.svcSt) {
    const ok = await busy(b, null, () => api(`/api/admin/services/${b.dataset.svcId}/status`, { method: 'POST', body: { status: b.dataset.svcSt } })).catch(() => null);
    if (ok) toast('Service updated');
  }
  route();
});

// ---------------------------------------------------------------- overview
async function viewOverview() {
  const d = await api('/api/admin/overview');
  const svcTable = (rows, empty) => table(['Customer', 'Vehicle', 'Service', 'Due', ''], rows.map((s) => html`<tr class="click" data-href="#/customer/${s.customer_id}"><td>${who(s)}</td><td>${s.make} ${s.model}<br><span class="plate" style="font-size:11px">${s.reg_no}</span></td><td>${s.title}</td>
    <td class="num">${fmtDate(s.due_on)}<br><span class="muted small">${relDays(s.days)}</span></td><td style="text-align:right"><a class="btn sm" href="tel:${s.customer_phone}">${icon('phone')} Call</a></td></tr>`), empty);
  const bkTable = (rows, empty) => table(['When', 'Customer', 'Vehicle', 'Service', ''], rows.map((b) => html`<tr><td class="num"><b>${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${b.slot}</td><td>${who(b)}</td><td>${b.vehicle_label}<br><span class="plate" style="font-size:11px">${b.vehicle.reg_no}</span></td>
    <td>${b.service}${b.notes ? html`<br><span class="muted small">“${b.notes}”</span>` : ''}</td><td>${bookingActions(b)}</td></tr>`), empty);
  const r = d.revenue;
  shell('#/', html`
    <div class="page-head"><div><span class="eyebrow">${fmtDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })}</span><h1 class="h-display">Overview</h1></div>
      <a class="btn primary" href="#/customers?new=1">${icon('plus')} New customer</a></div>
    <div class="grid ${r ? 'four' : 'three'}">
      ${r ? html`<a class="stat" href="#/finance"><span class="label">Collected today</span><b class="num">${money(r.day.collected)}</b><span class="muted small">${money(r.month.collected)} this month</span></a>` : ''}
      <div class="stat"><span class="label">Unpaid invoices</span><b class="num">${d.counts.unpaid_invoices}</b>${r ? html`<span class="muted small">${money(r.outstanding)} outstanding</span>` : ''}</div>
      <div class="stat"><span class="label">Customers</span><b class="num">${d.counts.customers}</b></div>
      <div class="stat"><span class="label">Active warranties</span><b class="num">${d.counts.active_warranties}</b></div>
    </div>
    ${isSuper() && d.counts.pending_discounts ? html`<a class="alert" href="#/approvals" style="margin-top:16px">${icon('tag')}<div class="grow"><b>${d.counts.pending_discounts} discount request${d.counts.pending_discounts > 1 ? 's' : ''} waiting for approval</b></div><span class="btn sm">Review</span></a>` : ''}
    ${d.low_stock.length ? html`<a class="alert bad" href="#/inventory" style="margin-top:16px">${icon('alert')}<div class="grow"><b>Low stock: ${d.low_stock.map((i) => `${i.brand} ${i.sub_brand}`).join(', ')}</b><p class="muted small">Restock soon. Bookings for a service stop when stock falls below one vehicle.</p></div><span class="btn sm">Inventory</span></a>` : ''}
    <section class="section"><div class="section-head"><h2 class="h-section">Booking requests</h2><span class="muted small">${d.requests.length}</span></div>${bkTable(d.requests, 'No pending requests.')}</section>
    <section class="section"><div class="section-head"><h2 class="h-section">Next 7 days</h2></div>${bkTable(d.schedule, 'Nothing confirmed for the coming week.')}</section>
    <section class="section"><div class="section-head"><h2 class="h-section" style="color:#ff6a55">Missed services</h2><span class="muted small">${d.missed.length}</span></div>${svcTable(d.missed, 'No missed services.')}</section>
    <section class="section"><div class="section-head"><h2 class="h-section">Due soon</h2><span class="muted small">${d.due_soon.length}</span></div>${svcTable(d.due_soon, 'Nothing due in the next two weeks.')}</section>`);
  bindRowLinks();
}

// ---------------------------------------------------------------- notifications
async function viewNotifications() {
  const { notifications } = await api('/api/admin/notifications');
  const ICON = { inventory: 'alert', discount: 'tag', marketing: 'chat' };
  shell(null, html`
    <div class="page-head"><div><span class="eyebrow">Inbox</span><h1 class="h-display">Alerts</h1></div></div>
    ${notifications.length ? html`<div class="list" style="display:block">${notifications.map((n) => html`
      <a class="notif ${n.read_at ? '' : 'unread'} k-${n.kind === 'inventory' ? 'missed' : n.kind === 'marketing' ? 'upcoming' : 'invoice'}" href="${n.link || '#/'}">
        <span class="ico">${icon(ICON[n.kind] || 'bell')}</span>
        <span style="flex:1"><b style="font-weight:600">${n.title}</b>${n.body ? html`<p class="muted small" style="margin-top:4px;white-space:pre-line">${n.body}</p>` : ''}
          <p class="label" style="margin-top:6px;font-size:10px">${new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</p></span>
        <span class="dot"></span></a>`)}</div>` : html`<div class="empty">No alerts yet.</div>`}`);
  if (A.unread) { api('/api/admin/notifications/read', { method: 'POST' }).catch(() => {}); A.unread = 0; }
}

// ---------------------------------------------------------------- customers
async function viewCustomers(q = '') {
  const { customers } = await api('/api/admin/customers?q=' + encodeURIComponent(q));
  shell('#/customers', html`
    <div class="page-head"><div><span class="eyebrow">Directory</span><h1 class="h-display">Customers</h1></div><button class="btn primary" id="new">${icon('plus')} New customer</button></div>
    <form id="sf" style="display:flex;gap:8px;margin-bottom:18px"><input class="input" name="q" placeholder="Search name, mobile or registration" value="${q}"><button class="btn" aria-label="Search">${icon('search')}</button></form>
    ${table(['Name', 'Mobile', 'Vehicles', 'Since'], customers.map((c) => html`<tr class="click" data-href="#/customer/${c.id}"><td><b style="font-weight:600">${c.name || 'Unnamed (not signed in yet)'}</b>${c.email ? html`<br><span class="muted small">${c.email}</span>` : ''}</td>
      <td class="num">${fmtPhone(c.phone)}</td><td>${c.regs || html`<span class="muted">—</span>`}</td><td class="muted small">${fmtDate(c.created_at.slice(0, 10))}</td></tr>`), 'No customers match.')}`);
  bindRowLinks();
  const sf = root.querySelector('#sf');
  sf.addEventListener('submit', (e) => { e.preventDefault(); viewCustomers(sf.q.value); });
  root.querySelector('#new').onclick = newCustomer;
  if (query().get('new')) { history.replaceState(null, '', '#/customers'); newCustomer(); }
}

function newCustomer() {
  const sh = sheet('New customer', html`<form novalidate>
    <label class="field"><span>Mobile number</span><input class="input" name="phone" type="tel" inputmode="numeric" required placeholder="98765 43210"></label>
    <label class="field"><span>Name</span><input class="input" name="name" maxlength="80"></label>
    <label class="field"><span>Email (optional)</span><input class="input" name="email" type="email" maxlength="120"></label>
    <p class="hint" style="margin-bottom:16px">The customer signs in with this number using an SMS code.</p>
    <p class="error" hidden></p><button class="btn primary block">Create</button></form>`);
  const f = sh.el.querySelector('form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => api('/api/admin/customers', { method: 'POST', body: formData(f) })).catch(() => null);
    if (out) { sh.close(); toast(out.existed ? 'Customer already exists: opening record' : 'Customer created'); go('#/customer/' + out.customer.id); }
  });
}

/** Generic sheet with a form that POSTs and reloads. */
function formSheet(title, body, submit, msg, after) {
  const sh = sheet(title, body);
  const f = sh.el.querySelector('form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await busy(f.querySelector('button.primary'), f.querySelector('.error'), () => submit(f)).catch(() => null);
    if (out) { sh.close(); toast(typeof msg === 'function' ? msg(out) : msg); (after || route)(); }
  });
  return { sh, f };
}

const warrantyFields = (prefix = '') => html`
  <div class="field"><span>Warranty type</span><div class="seg"><label><input type="radio" name="${prefix}kind" value="ceramic" checked><span>Ceramic coating</span></label><label><input type="radio" name="${prefix}kind" value="ppf"><span>PPF</span></label></div></div>
  <div class="row two"><label class="field"><span>Brand</span><select class="input" name="${prefix}brand"></select></label>
    <label class="field"><span>Product / package</span><input class="input" name="${prefix}product" list="prod-list" placeholder="e.g. Signature coat (9H)"></label></div>
  <label class="field"><span>Coverage</span><input class="input" name="${prefix}coverage" placeholder="e.g. Full body paint, glass and wheels"></label>
  <div class="row two"><label class="field"><span>Years</span><input class="input num" name="${prefix}years" value="3" inputmode="numeric"></label>
    <label class="field"><span>Inspection every (months)</span><input class="input num" name="${prefix}interval_months" value="6" inputmode="numeric"></label></div>`;
const PRODUCTS = { ceramic: ['Essential coat', 'Signature coat (9H)', 'Wheel & glass coating'], ppf: ['Gloss PPF: full body', 'Gloss PPF: front kit', 'Matte PPF: full body', 'Gloss PPF, 190 micron'] };
/** Keeps a warranty fieldset's brand list in step with its type. */
function wireWarranty(scope, prefix = '') {
  const sync = () => {
    const k = scope.querySelector(`[name="${prefix}kind"]:checked`).value;
    scope.querySelector(`[name="${prefix}brand"]`).innerHTML = A.brands.filter((b) => b[k]).map((b) => html`<option>${b.name}</option>`.s).join('');
    const dl = document.getElementById('prod-list');
    if (dl) dl.innerHTML = PRODUCTS[k].map((p) => html`<option value="${p}">`.s).join('');
    scope.querySelector(`[name="${prefix}years"]`).value = k === 'ppf' ? 5 : 3;
    scope.querySelector(`[name="${prefix}interval_months"]`).value = k === 'ppf' ? 12 : 6;
  };
  scope.querySelectorAll(`[name="${prefix}kind"]`).forEach((r) => r.addEventListener('change', sync));
  sync();
}
const readWarranty = (scope, prefix = '') => ({
  kind: scope.querySelector(`[name="${prefix}kind"]:checked`).value,
  brand: scope.querySelector(`[name="${prefix}brand"]`).value,
  product: scope.querySelector(`[name="${prefix}product"]`).value,
  coverage: scope.querySelector(`[name="${prefix}coverage"]`).value,
  years: scope.querySelector(`[name="${prefix}years"]`).value,
  interval_months: scope.querySelector(`[name="${prefix}interval_months"]`).value,
});

// ---------------------------------------------------------------- customer detail
async function viewCustomer(id) {
  const [d, { brands }] = await Promise.all([api('/api/admin/customers/' + id), api('/api/admin/brands')]);
  A.brands = brands;
  const c = d.customer;
  const vOpts = (sel) => d.vehicles.map((v) => html`<option value="${v.id}" ${String(sel) === String(v.id) ? raw('selected') : ''}>${v.make} ${v.model} · ${v.reg_no}</option>`);
  const head = (title, buttons) => html`<div class="section-head"><h2 class="h-section">${title}</h2><div style="display:flex;gap:8px;flex-wrap:wrap">${buttons || ''}</div></div>`;
  const btn = (bid, label, disabled) => html`<button class="btn sm" id="${bid}" ${disabled ? raw('disabled title="Add a vehicle first"') : ''}>${icon('plus')} ${label}</button>`;
  const approved = d.discounts.filter((x) => x.status === 'approved');

  shell('#/customers', html`
    <a class="back" href="#/customers">${icon('left')} Customers</a>
    <div class="page-head"><div><span class="eyebrow">Customer</span><h1 class="h-display">${c.name || 'Unnamed'}</h1>
      <p class="muted" style="margin-top:8px">${fmtPhone(c.phone)}${c.email ? ' · ' + c.email : ''}</p></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn sm" href="tel:${c.phone}">${icon('phone')} Call</a><button class="btn sm" id="editc">${icon('edit')} Edit</button>
        ${isSuper() ? html`<button class="btn sm" id="phone">${icon('phone')} Change mobile</button>` : ''}</div></div>

    <section>${head('Vehicles', btn('addv', 'Add vehicle'))}
      ${d.vehicles.length ? html`<div class="grid three">${d.vehicles.map((v) => html`<div class="card"><p class="h-card">${v.make} ${v.model}</p><p class="muted small">${v.kind === 'bike' ? 'Motorcycle' : 'Car'}${v.year ? ' · ' + v.year : ''}${v.colour ? ' · ' + v.colour : ''}</p><p style="margin-top:10px"><span class="plate">${v.reg_no}</span></p></div>`)}</div>`
        : html`<div class="empty small">No vehicles yet.</div>`}</section>

    <section class="section">${head('Invoices', html`${btn('addi', 'New invoice')}${btn('reqd', isSuper() ? 'Give discount' : 'Request discount')}`)}
      ${approved.length ? html`<p class="hint" style="margin:-4px 0 12px">Approved discount ready to use: ${approved.map((x) => money(x.amount)).join(', ')}. Pick it when creating the invoice.</p>` : ''}
      ${table(['No.', 'Date', 'Vehicle', 'Items', 'Total', 'Payment', ''], d.invoices.map((i) => html`<tr>
        <td class="mono">${i.invoice_no}</td><td class="num">${fmtDate(i.issued_on)}</td><td>${i.vehicle_label || '—'}</td>
        <td class="small">${i.items.map((x) => x.desc).join('; ')}${i.discount ? html`<br><span class="muted">Discount ${money(i.discount)}</span>` : ''}
          ${i.pending_warranties.length ? html`<br><span class="chip ${i.discount ? 'warn' : 'dim'}" style="margin-top:6px">${i.discount ? 'Warranty: Super Admin to issue' : 'Warranty issues on full payment'}</span>` : ''}</td>
        <td class="num" style="text-align:right;font-weight:600">${money(i.total)}${i.amount_paid && i.amount_paid < i.total ? html`<br><span class="muted small">paid ${money(i.amount_paid)}</span>` : ''}</td>
        <td>${payChip(i)}</td>
        <td style="text-align:right;white-space:nowrap">${i.amount_paid < i.total ? html`<button class="btn sm primary" data-pay="${i.id}">Record payment</button>` : ''}
          ${isSuper() && i.pending_warranties.length && (i.discount || i.amount_paid >= i.total) ? html` <button class="btn sm" data-issue="${i.id}">Issue warranty</button>` : ''}</td></tr>`), 'No invoices.')}
      ${d.discounts.length ? html`<details style="margin-top:12px"><summary class="label" style="cursor:pointer">Discount requests (${d.discounts.length})</summary>
        <div class="stack" style="margin-top:10px">${d.discounts.map((x) => html`<div class="card-row small"><span class="grow">${money(x.amount)} · ${x.reason || ''}<br><span class="muted">${fmtDate(x.created_at.slice(0, 10))}</span></span><span class="chip ${x.status === 'approved' ? 'ok' : x.status === 'rejected' ? 'bad' : x.status === 'used' ? 'dim' : 'warn'}">${x.status}</span></div>`)}</div></details>` : ''}
    </section>

    <section class="section">${head('Warranties', isSuper() ? btn('addw', 'Issue warranty', !d.vehicles.length) : '')}
      ${table(['Certificate', 'Type', 'Brand / product', 'Vehicle', 'Valid', 'Status'], d.warranties.map((w) => html`<tr><td class="mono">${w.cert_no}${w.auto ? html`<br><span class="muted small">auto-issued</span>` : ''}</td><td>${kindName(w.kind)}</td><td><b style="font-weight:600">${w.brand}</b><br><span class="muted small">${w.product}</span></td><td>${w.vehicle_label}</td>
        <td class="num small">${fmtDate(w.starts_on)} – ${fmtDate(w.ends_on)}<br><span class="muted">every ${w.interval_months} mo</span></td><td>${healthChip(w.health)}</td></tr>`), 'No warranties.')}</section>

    <section class="section">${head('Service schedule', btn('adds', 'Add service date', !d.vehicles.length))}
      ${table(['Due', 'Service', 'Vehicle', 'Status', ''], d.services.map((s) => html`<tr><td class="num">${fmtDate(s.due_on)}${s.status === 'due' ? html`<br><span class="muted small">${relDays(s.days)}</span>` : ''}</td><td>${s.title}${s.done_on ? html`<br><span class="muted small">done ${fmtDate(s.done_on)}</span>` : ''}</td>
        <td>${s.make} ${s.model}</td><td>${serviceChip(s)}</td>
        <td style="text-align:right;white-space:nowrap">${s.status === 'due' || s.status === 'booked'
          ? html`<button class="btn sm" data-svc-st="done" data-svc-id="${s.id}">Mark done</button> <button class="btn sm danger" data-svc-st="skipped" data-svc-id="${s.id}">Skip</button>`
          : html`<button class="btn sm" data-svc-st="due" data-svc-id="${s.id}">Reopen</button>`}</td></tr>`), 'No service dates.')}</section>

    <section class="section">${head('Bookings')}
      ${table(['When', 'Service', 'Vehicle', 'Status', ''], d.bookings.map((b) => html`<tr><td class="num">${fmtDate(b.date)}<br>${b.slot}</td><td>${b.service}${b.notes ? html`<br><span class="muted small">“${b.notes}”</span>` : ''}</td><td>${b.vehicle_label}</td><td>${bookingChip(b.status)}</td><td>${bookingActions(b)}</td></tr>`), 'No bookings.')}</section>`);

  const reload = () => viewCustomer(id);

  root.querySelector('#editc').onclick = () => formSheet('Edit customer', html`<form novalidate><label class="field"><span>Name</span><input class="input" name="name" value="${c.name || ''}"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${c.email || ''}"></label><p class="error" hidden></p><button class="btn primary block">Save</button></form>`,
  (f) => api('/api/admin/customers/' + c.id, { method: 'PATCH', body: formData(f) }), 'Saved', reload);

  if (isSuper()) {
    root.querySelector('#phone').onclick = () => formSheet('Change mobile number', html`<form novalidate>
      <p class="muted" style="margin-bottom:16px">Current: <b>${fmtPhone(c.phone)}</b>. The customer signs in with the new number from now on and is signed out of any open sessions.</p>
      <label class="field"><span>New mobile number</span><input class="input" name="phone" type="tel" inputmode="numeric" required></label>
      <p class="error" hidden></p><button class="btn primary block">Change number</button></form>`,
    (f) => api(`/api/admin/customers/${c.id}/phone`, { method: 'POST', body: formData(f) }), 'Mobile number changed', reload);
  }

  root.querySelector('#addv').onclick = () => formSheet('Add vehicle', html`<form novalidate>
    <div class="field"><span>Type</span><div class="seg"><label><input type="radio" name="kind" value="car" checked><span>Car</span></label><label><input type="radio" name="kind" value="bike"><span>Motorcycle</span></label></div></div>
    <div class="row two"><label class="field"><span>Make</span><input class="input" name="make" required></label><label class="field"><span>Model</span><input class="input" name="model" required></label></div>
    <label class="field"><span>Registration</span><input class="input" name="reg_no" required style="text-transform:uppercase"></label>
    <div class="row two"><label class="field"><span>Year</span><input class="input" name="year" inputmode="numeric"></label><label class="field"><span>Colour</span><input class="input" name="colour"></label></div>
    <p class="error" hidden></p><button class="btn primary block">Add vehicle</button></form>`,
  (f) => api(`/api/admin/customers/${c.id}/vehicles`, { method: 'POST', body: formData(f) }), 'Vehicle added', reload);

  // --- discount request (Admin) / direct discount approval (Super Admin)
  root.querySelector('#reqd').onclick = () => formSheet(isSuper() ? 'Give a discount' : 'Request a discount', html`<form novalidate>
    <p class="muted" style="margin-bottom:16px">${isSuper() ? 'This discount is approved immediately and can be used on the next invoice.' : 'The Super Admin gets an alert. Once approved, you can apply it when creating the invoice.'}</p>
    <label class="field"><span>Vehicle</span><select class="input" name="vehicle_id"><option value="">—</option>${vOpts()}</select></label>
    <label class="field"><span>Discount amount (₹, before GST)</span><input class="input num" name="amount" inputmode="decimal" required></label>
    <label class="field"><span>Reason</span><input class="input" name="reason" maxlength="300" required placeholder="e.g. Repeat customer, second car"></label>
    <p class="error" hidden></p><button class="btn primary block">${isSuper() ? 'Approve discount' : 'Send for approval'}</button></form>`,
  (f) => api('/api/admin/discounts', { method: 'POST', body: { ...formData(f), customer_id: c.id } }), isSuper() ? 'Discount approved' : 'Sent to the Super Admin for approval', reload);

  // --- new invoice
  root.querySelector('#addi').onclick = () => {
    let n = 0;
    const line = () => { const k = n++; return html`<div class="inv-line" data-line="${k}">
      <div class="items-grid"><input class="input" name="desc" placeholder="Description" list="svc-list"><input class="input num" name="qty" value="1" inputmode="numeric" aria-label="Quantity"><input class="input num" name="rate" placeholder="₹ rate" inputmode="decimal" aria-label="Rate"><button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button></div>
      <label class="small warranty-toggle"><input type="checkbox" data-wt> This line carries a ceramic / PPF warranty</label>
      <div class="warranty-box" hidden>${warrantyFields('w' + k + '_')}</div></div>`; };
    const { sh, f } = formSheet('New invoice', html`<form novalidate>
      <div class="row two"><label class="field"><span>Vehicle</span><select class="input" name="vehicle_id"><option value="">—</option>${vOpts(d.vehicles[0]?.id)}</select></label>
        <label class="field"><span>Date</span><input class="input" type="date" name="issued_on" value="${todayStr()}"></label></div>
      <div class="field"><span>Line items (rates exclude GST)</span><div id="lines">${line()}</div>
        <button type="button" class="btn sm" id="addline">${icon('plus')} Add line</button></div>
      <datalist id="svc-list">${A.services.map((s) => html`<option value="${s}">`)}</datalist><datalist id="prod-list"></datalist>
      ${isSuper()
    ? html`<div class="row two"><label class="field"><span>Discount ₹</span><input class="input num" name="discount" value="0" inputmode="decimal"></label>
          <label class="field"><span>GST %</span><input class="input num" name="tax_rate" value="${A.gstRate}" inputmode="decimal"></label></div>`
    : html`<label class="field"><span>Discount</span><select class="input" name="discount_request_id"><option value="">No discount</option>${approved.map((x) => html`<option value="${x.id}">${money(x.amount)} approved: ${x.reason || ''}</option>`)}</select></label>
          ${!approved.length ? html`<p class="hint" style="margin:-8px 0 14px">Need a discount? Use “Request discount” first; the Super Admin must approve it.</p>` : ''}`}
      <div class="row two"><label class="field"><span>Payment now</span><select class="input" name="pay"><option value="">Not paid yet</option><option value="full">Paid in full</option><option value="part">Part payment</option></select></label>
        <label class="field"><span>Mode</span><select class="input" name="mode"><option>UPI</option><option>Card</option><option>Cash</option><option>Bank transfer</option></select></label></div>
      <label class="field" id="partamt" hidden><span>Amount received ₹</span><input class="input num" name="part_amount" inputmode="decimal"></label>
      <label class="field"><span>Notes</span><textarea class="input" name="notes" maxlength="500"></textarea></label>
      <p class="hint" id="calc" style="margin-bottom:12px"></p>
      <p class="error" hidden></p><button class="btn primary block">Create invoice</button></form>`,
    (form) => {
      const items = [...form.querySelectorAll('.inv-line')].map((el) => {
        const it = { desc: el.querySelector('[name=desc]').value, qty: el.querySelector('[name=qty]').value, rate: el.querySelector('[name=rate]').value };
        if (el.querySelector('[data-wt]').checked) it.warranty = readWarranty(el, 'w' + el.dataset.line + '_');
        return it;
      });
      const pay = form.pay.value;
      return api('/api/admin/invoices', { method: 'POST', body: {
        customer_id: c.id, vehicle_id: form.vehicle_id.value || null, issued_on: form.issued_on.value, items, notes: form.notes.value,
        discount: form.discount?.value, tax_rate: form.tax_rate?.value, discount_request_id: form.discount_request_id?.value || null,
        payment: pay ? { amount: pay === 'full' ? 'full' : form.part_amount.value, mode: form.mode.value } : null,
      } });
    }, 'Invoice created. The customer has been notified', reload);
    const wire = (el) => { el.querySelector('[data-wt]').addEventListener('change', (e) => { const box = el.querySelector('.warranty-box'); box.hidden = !e.target.checked; if (e.target.checked) wireWarranty(box, 'w' + el.dataset.line + '_'); }); };
    f.querySelectorAll('.inv-line').forEach(wire);
    const calc = () => {
      const sub = [...f.querySelectorAll('.inv-line')].reduce((s, r) => s + (Number(r.querySelector('[name=qty]').value) || 0) * (Number(r.querySelector('[name=rate]').value) || 0), 0);
      const disc = f.discount ? Number(f.discount.value) || 0 : (approved.find((x) => String(x.id) === f.discount_request_id.value)?.amount || 0) / 100;
      const rate = f.tax_rate ? Number(f.tax_rate.value) || 0 : A.gstRate;
      const total = Math.max(0, sub - disc) * (1 + rate / 100);
      f.querySelector('#calc').textContent = `Subtotal ${money(sub * 100)}${disc ? ` · discount ${money(disc * 100)}` : ''} · Total incl. GST ${money(Math.round(total * 100))}`;
    };
    f.addEventListener('input', calc); f.addEventListener('change', calc);
    f.pay.addEventListener('change', () => { f.querySelector('#partamt').hidden = f.pay.value !== 'part'; });
    f.querySelector('#addline').onclick = () => { f.querySelector('#lines').insertAdjacentHTML('beforeend', line().s); wire(f.querySelector('#lines').lastElementChild); };
    f.addEventListener('click', (e) => { const rm = e.target.closest('[data-rm]'); if (rm && f.querySelectorAll('.inv-line').length > 1) { rm.closest('.inv-line').remove(); calc(); } });
    calc();
    void sh;
  };

  // --- record payment
  root.querySelectorAll('[data-pay]').forEach((b) => { b.onclick = () => {
    const i = d.invoices.find((x) => String(x.id) === b.dataset.pay);
    const bal = i.total - i.amount_paid;
    const { f } = formSheet('Record payment', html`<form novalidate>
      <dl class="kv" style="margin-bottom:18px"><dt>Invoice</dt><dd class="mono">${i.invoice_no}</dd><dt>Total</dt><dd>${money(i.total)}</dd><dt>Paid so far</dt><dd>${money(i.amount_paid)}</dd><dt><b>Balance</b></dt><dd><b>${money(bal)}</b></dd></dl>
      <div class="field"><span>Payment status</span><div class="seg"><label><input type="radio" name="st" value="full" checked><span>Paid in full</span></label><label><input type="radio" name="st" value="part"><span>Part payment</span></label></div></div>
      <label class="field" id="amt" hidden><span>Amount received ₹</span><input class="input num" name="amount" inputmode="decimal"></label>
      <div class="row two"><label class="field"><span>Mode</span><select class="input" name="mode"><option>UPI</option><option>Card</option><option>Cash</option><option>Bank transfer</option></select></label>
        <label class="field"><span>Date</span><input class="input" type="date" name="paid_on" value="${todayStr()}"></label></div>
      ${i.pending_warranties.length && !i.discount ? html`<p class="hint" style="margin-bottom:12px">The warranty will be issued automatically once this invoice is fully paid.</p>` : ''}
      <p class="error" hidden></p><button class="btn primary block">Save payment</button></form>`,
    (form) => api(`/api/admin/invoices/${i.id}/payments`, { method: 'POST', body: { amount: form.st.value === 'full' ? 'full' : form.amount.value, mode: form.mode.value, paid_on: form.paid_on.value } }),
    (out) => (out.warranties_issued ? `Payment saved. ${out.warranties_issued} warranty issued to the customer` : 'Payment saved'), reload);
    f.querySelectorAll('[name=st]').forEach((r) => r.addEventListener('change', () => { f.querySelector('#amt').hidden = f.st.value !== 'part'; }));
  }; });

  // --- issue warranty (Super Admin)
  const issueSheet = (inv, pending) => {
    const { f } = formSheet('Issue warranty', html`<form novalidate>
      <label class="field"><span>Vehicle</span><select class="input" name="vehicle_id">${vOpts(inv?.vehicle_id)}</select></label>
      ${pending ? html`<label class="field"><span>For invoice line</span><select class="input" name="invoice_line">${pending.map((p) => html`<option value="${p.line}">${p.desc}</option>`)}</select></label>` : ''}
      <datalist id="prod-list"></datalist>
      ${warrantyFields()}
      <label class="field"><span>Applied on</span><input class="input" type="date" name="starts_on" value="${inv?.issued_on || todayStr()}"></label>
      ${!inv ? html`<label class="field"><span>Linked invoice</span><select class="input" name="invoice_id"><option value="">—</option>${d.invoices.map((i) => html`<option value="${i.id}">${i.invoice_no} · ${fmtDate(i.issued_on)} · ${money(i.total)}</option>`)}</select></label>` : ''}
      <p class="hint" style="margin-bottom:12px">Inspection dates for the full term are scheduled automatically.</p>
      <p class="error" hidden></p><button class="btn primary block">Issue certificate</button></form>`,
    (form) => api('/api/admin/warranties', { method: 'POST', body: { ...readWarranty(form), customer_id: c.id, vehicle_id: form.vehicle_id.value, starts_on: form.starts_on.value,
      invoice_id: inv ? inv.id : form.invoice_id.value || null, invoice_line: form.invoice_line?.value } }), 'Warranty issued', reload);
    wireWarranty(f);
    const fill = (w) => {
      if (!w) return;
      f.querySelector(`[name=kind][value=${w.kind}]`).checked = true; f.querySelector(`[name=kind][value=${w.kind}]`).dispatchEvent(new Event('change'));
      f.brand.value = w.brand; f.product.value = w.product; f.coverage.value = w.coverage || ''; f.years.value = w.years; f.interval_months.value = w.interval_months;
    };
    if (pending) {
      const pick = () => fill(pending.find((p) => String(p.line) === f.invoice_line.value)?.warranty);
      f.invoice_line.addEventListener('change', pick); pick();
    }
  };
  if (isSuper()) {
    const aw = root.querySelector('#addw');
    if (aw) aw.onclick = () => issueSheet(null, null);
    root.querySelectorAll('[data-issue]').forEach((b) => { b.onclick = () => { const i = d.invoices.find((x) => String(x.id) === b.dataset.issue); issueSheet(i, i.pending_warranties); }; });
  }

  root.querySelector('#adds').onclick = () => formSheet('Add service date', html`<form novalidate>
    <label class="field"><span>Vehicle</span><select class="input" name="vehicle_id">${vOpts()}</select></label>
    <label class="field"><span>Service</span><input class="input" name="title" list="svc-list2" required value="Maintenance wash"></label>
    <datalist id="svc-list2">${A.services.map((s) => html`<option value="${s}">`)}</datalist>
    <label class="field"><span>Due on</span><input class="input" type="date" name="due_on" required></label>
    <p class="error" hidden></p><button class="btn primary block">Add</button></form>`,
  (f) => api('/api/admin/services', { method: 'POST', body: { ...formData(f), customer_id: c.id } }), 'Service date added', reload);
}

// ---------------------------------------------------------------- bookings
async function viewBookings() {
  const status = query().get('status') || 'requested';
  const { bookings } = await api('/api/admin/bookings?status=' + status);
  const tabs = ['requested', 'confirmed', 'completed', 'cancelled'];
  shell('#/bookings', html`
    <div class="page-head"><div><span class="eyebrow">Appointments</span><h1 class="h-display">Bookings</h1></div>
      <div class="seg">${tabs.map((t) => html`<label><input type="radio" name="tab" value="${t}" ${t === status ? raw('checked') : ''}><span>${t}</span></label>`)}</div></div>
    ${table(['When', 'Customer', 'Vehicle', 'Service', 'Status', ''], bookings.map((b) => html`<tr class="click" data-href="#/customer/${b.customer_id}"><td class="num"><b>${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${b.slot}</td><td>${who(b)}</td>
      <td>${b.vehicle_label}<br><span class="plate" style="font-size:11px">${b.vehicle.reg_no}</span></td><td>${b.service}${b.notes ? html`<br><span class="muted small">“${b.notes}”</span>` : ''}</td>
      <td>${bookingChip(b.status)}</td><td>${bookingActions(b)}</td></tr>`), `No ${status} bookings.`)}`);
  bindRowLinks();
  root.querySelectorAll('[name=tab]').forEach((r) => r.addEventListener('change', () => go('#/bookings?status=' + r.value)));
}

// ---------------------------------------------------------------- inventory
async function viewInventory() {
  const d = await api('/api/admin/inventory');
  const cats = d.categories;
  const itemStatus = (i) => (i.quantity <= 0 ? html`<span class="chip bad">Out</span>` : i.quantity <= i.reorder_level ? html`<span class="chip warn">Low</span>` : html`<span class="chip ok">OK</span>`);
  const byCat = cats.map((c) => ({ ...c, items: d.items.filter((i) => i.category === c.name) })).filter((c) => c.items.length);
  const services = (kind) => A.catalog.filter((c) => c.kinds.includes(kind)).map((c) => c.name);

  shell('#/inventory', html`
    <div class="page-head"><div><span class="eyebrow">Stock</span><h1 class="h-display">Inventory</h1></div>
      ${isSuper() ? html`<button class="btn primary" id="additem">${icon('plus')} Add item</button>` : ''}</div>
    ${d.paused.length ? html`<div class="alert bad" style="margin-bottom:18px">${icon('alert')}<div class="grow"><b>Bookings paused</b>
      ${d.paused.map((p) => html`<p class="muted small">${p.service} (${p.kind === 'bike' ? 'motorcycles' : 'cars'}): ${p.reason}</p>`)}</div></div>` : ''}
    ${byCat.length ? byCat.map((c) => html`<section style="margin-bottom:26px"><div class="section-head"><h2 class="h-card">${c.name}</h2><span class="muted small">measured in ${c.unit}</span></div>
      ${table(['Brand', 'Sub-brand / product', 'Pack size', 'In stock', 'Reorder at', 'Status', ''], c.items.map((i) => html`<tr>
        <td><b style="font-weight:600">${i.brand}</b></td><td>${i.sub_brand}</td><td class="num">${i.pack_size ? qty(i.pack_size, i.unit) : '—'}</td>
        <td class="num"><b>${qty(i.quantity, i.unit)}</b>${i.pack_size ? html`<br><span class="muted small">≈ ${Math.round((i.quantity / i.pack_size) * 10) / 10} packs</span>` : ''}</td>
        <td class="num">${qty(i.reorder_level, i.unit)}</td><td>${itemStatus(i)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn sm primary" data-recv="${i.id}">Receive stock</button>
          ${isSuper() ? html` <button class="btn sm" data-count="${i.id}">Count</button> <button class="btn sm" data-edit="${i.id}">${icon('edit')}</button>` : ''}</td></tr>`), '')}</section>`)
    : html`<div class="empty"><p class="h-card">No stock items yet</p><p>${isSuper() ? 'Add your products (brand, sub-brand, pack size and quantity). Tracking starts as soon as a category has an item.' : 'The Super Admin adds stock items.'}</p></div>`}

    <section class="section"><div class="section-head"><h2 class="h-section">Usage per vehicle</h2>${isSuper() ? html`<button class="btn sm" id="addstd">${icon('plus')} Add / change</button>` : ''}</div>
      <p class="hint" style="margin:-4px 0 14px">Deducted from stock when a booking is completed. When stock can’t cover one more vehicle (after bookings already taken), customers can’t book that service.</p>
      <div class="grid two">${['car', 'bike'].map((k) => html`<div>${table([k === 'car' ? 'Car service' : 'Motorcycle service', 'Uses', 'Per vehicle'],
        d.standards.filter((s) => s.kind === k).map((s) => html`<tr><td>${s.service}</td><td>${s.category}</td><td class="num">${qty(s.amount, cats.find((c) => c.name === s.category)?.unit || '')}</td></tr>`), 'No standards set.')}</div>`)}</div></section>

    <section class="section"><div class="section-head"><h2 class="h-section">Recent movements</h2></div>
      ${table(['When', 'Item', 'Change', 'Reason', 'By'], d.moves.map((m) => html`<tr><td class="small">${fmtDate(m.created_at.slice(0, 10))}</td><td>${m.brand} ${m.sub_brand}</td>
        <td class="num" style="color:${m.delta < 0 ? '#ff8a78' : 'var(--sage)'}">${m.delta > 0 ? '+' : ''}${qty(m.delta, m.unit)}</td><td>${m.reason}${m.booking_id ? ` · booking #${m.booking_id}` : ''}</td><td class="small">${m.staff_name || '—'}</td></tr>`), 'No stock movements yet.')}</section>`);

  const itemForm = (i = {}) => html`<form novalidate>
    <label class="field"><span>Category</span><select class="input" name="category">${cats.map((c) => html`<option ${i.category === c.name ? raw('selected') : ''} value="${c.name}">${c.name} (${c.unit})</option>`)}</select></label>
    <div class="row two"><label class="field"><span>Brand</span><input class="input" name="brand" required value="${i.brand || ''}" placeholder="e.g. Koch-Chemie"></label>
      <label class="field"><span>Sub-brand / product</span><input class="input" name="sub_brand" required value="${i.sub_brand || ''}" placeholder="e.g. Heavy Cut H9.02"></label></div>
    <div class="row three"><label class="field"><span>Pack size</span><input class="input num" name="pack_size" inputmode="decimal" value="${i.pack_size ?? ''}" placeholder="e.g. 1000"></label>
      ${i.id ? '' : html`<label class="field"><span>In stock now</span><input class="input num" name="quantity" inputmode="decimal" placeholder="total in unit"></label>`}
      <label class="field"><span>Reorder at</span><input class="input num" name="reorder_level" inputmode="decimal" value="${i.reorder_level ?? ''}"></label></div>
    <label class="field"><span>Cost per unit ₹ (optional, for the forecast)</span><input class="input num" name="unit_cost" inputmode="decimal" value="${i.unit_cost ?? ''}"></label>
    <p class="hint" style="margin-bottom:12px">Quantities are in the category’s unit (ml, sq ft or pcs). For 2 × 1 litre bottles, enter pack size 1000 and in stock 2000.</p>
    <p class="error" hidden></p><button class="btn primary block">${i.id ? 'Save' : 'Add item'}</button>
    ${i.id ? html`<button type="button" class="btn block danger" id="rmitem" style="margin-top:8px">Remove item</button>` : ''}</form>`;
  if (isSuper()) {
    root.querySelector('#additem').onclick = () => formSheet('Add stock item', itemForm(), (f) => api('/api/admin/inventory/items', { method: 'POST', body: formData(f) }), 'Item added');
    root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => {
      const i = d.items.find((x) => String(x.id) === b.dataset.edit);
      const { sh, f } = formSheet('Edit item', itemForm(i), (form) => api('/api/admin/inventory/items/' + i.id, { method: 'PATCH', body: formData(form) }), 'Saved');
      f.querySelector('#rmitem').onclick = async () => { if (!confirm('Remove this item from inventory?')) return; await api('/api/admin/inventory/items/' + i.id, { method: 'PATCH', body: { active: false } }); sh.close(); route(); };
    }; });
    root.querySelectorAll('[data-count]').forEach((b) => { b.onclick = () => {
      const i = d.items.find((x) => String(x.id) === b.dataset.count);
      formSheet('Stock count', html`<form novalidate><p class="muted" style="margin-bottom:16px">${i.brand} ${i.sub_brand}: the app shows ${qty(i.quantity, i.unit)}. Enter what you actually counted.</p>
        <label class="field"><span>Counted quantity (${i.unit})</span><input class="input num" name="quantity" inputmode="decimal" required></label>
        <p class="error" hidden></p><button class="btn primary block">Save count</button></form>`,
      (f) => api(`/api/admin/inventory/items/${i.id}/stock`, { method: 'POST', body: { mode: 'count', quantity: f.quantity.value } }), 'Stock corrected');
    }; });
    root.querySelector('#addstd').onclick = () => {
      const { f } = formSheet('Usage per vehicle', html`<form novalidate>
        <div class="field"><span>Vehicle</span><div class="seg"><label><input type="radio" name="kind" value="car" checked><span>Car</span></label><label><input type="radio" name="kind" value="bike"><span>Motorcycle</span></label></div></div>
        <label class="field"><span>Service</span><select class="input" name="service"></select></label>
        <label class="field"><span>Uses (category)</span><select class="input" name="category">${cats.map((c) => html`<option value="${c.name}">${c.name} (${c.unit})</option>`)}</select></label>
        <label class="field"><span>Amount per vehicle (0 removes it)</span><input class="input num" name="amount" inputmode="decimal" required></label>
        <p class="error" hidden></p><button class="btn primary block">Save</button></form>`,
      (form) => api('/api/admin/inventory/standards', { method: 'POST', body: formData(form) }), 'Usage standard saved');
      const sync = () => { f.service.innerHTML = services(f.kind.value).map((s) => html`<option>${s}</option>`.s).join(''); };
      f.querySelectorAll('[name=kind]').forEach((r) => r.addEventListener('change', sync)); sync();
    };
  }
  root.querySelectorAll('[data-recv]').forEach((b) => { b.onclick = () => {
    const i = d.items.find((x) => String(x.id) === b.dataset.recv);
    formSheet('Receive stock', html`<form novalidate><p class="muted" style="margin-bottom:16px">${i.brand} ${i.sub_brand}${i.pack_size ? ` · pack ${qty(i.pack_size, i.unit)}` : ''}</p>
      <label class="field"><span>Quantity received (${i.unit})</span><input class="input num" name="quantity" inputmode="decimal" required ${i.pack_size ? raw(`value="${i.pack_size}"`) : ''}></label>
      <label class="field"><span>Purchase cost ₹ (optional, recorded as an inventory expense)</span><input class="input num" name="cost" inputmode="decimal"></label>
      <p class="error" hidden></p><button class="btn primary block">Add to stock</button></form>`,
    (f) => api(`/api/admin/inventory/items/${i.id}/stock`, { method: 'POST', body: { mode: 'received', quantity: f.quantity.value, cost: f.cost.value } }), 'Stock updated');
  }; });
}

// ---------------------------------------------------------------- finance (Super Admin)
async function viewFinance() {
  const d = await api('/api/admin/finance');
  const r = d.revenue;
  const P = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']];
  const CAT = { rent: 'Rent', inventory: 'Inventory', salary: 'Salary', maintenance: 'Maintenance' };
  const monthName = (ym) => new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  shell('#/finance', html`
    <div class="page-head"><div><span class="eyebrow">Super Admin</span><h1 class="h-display">Finance</h1></div><button class="btn primary" id="addexp">${icon('plus')} Add expense</button></div>
    <div class="grid four">${P.map(([k, label]) => html`<div class="stat"><span class="label">${label}</span><b class="num">${money(r[k].collected)}</b>
      <span class="muted small">collected · ${money(r[k].invoiced)} invoiced (${r[k].invoices})</span>
      <div class="divider" style="margin:12px 0"></div>
      <span class="small">Expenses ${money(r[k].expenses)}</span><br><span class="small" style="color:${r[k].net < 0 ? '#ff8a78' : 'var(--sage)'}">Net ${money(r[k].net)}</span></div>`)}</div>
    <p class="muted small" style="margin-top:10px">Outstanding (unpaid invoices): <b>${money(r.outstanding)}</b>. “Collected” counts payments by the date received.</p>

    <section class="section"><div class="section-head"><h2 class="h-section">Forecast: ${monthName(d.forecast.month)}</h2><b class="num">${money(d.forecast.total)}</b></div>
      ${table(['Category', ...d.forecast.lines[0].history.slice(-3).map((h) => monthName(h.month)), 'Forecast', 'How'], d.forecast.lines.map((l) => html`<tr><td><b style="font-weight:600">${CAT[l.category]}</b></td>
        ${l.history.slice(-3).map((h) => html`<td class="num">${h.total ? money(h.total) : html`<span class="muted">—</span>`}</td>`)}
        <td class="num"><b>${money(l.forecast)}</b></td><td class="muted small">${l.method}</td></tr>`), '')}
      <p class="hint" style="margin-top:10px">The forecast improves as you record expenses each month. Rent and salary repeat the latest month; inventory and maintenance use a weighted average of recent months, and inventory is at least the value of stock used.</p></section>

    <section class="section"><div class="section-head"><h2 class="h-section">Last 12 months</h2></div>
      ${table(['Month', 'Collected', 'Expenses', 'Net'], r.months.slice().reverse().map((m) => html`<tr><td>${monthName(m.month)}</td><td class="num">${money(m.collected)}</td><td class="num">${money(m.expenses)}</td>
        <td class="num" style="color:${m.collected - m.expenses < 0 ? '#ff8a78' : 'inherit'}">${money(m.collected - m.expenses)}</td></tr>`), '')}</section>

    <section class="section"><div class="section-head"><h2 class="h-section">Expenses</h2></div>
      ${table(['Date', 'Category', 'Amount', 'Note', 'By', ''], d.expenses.map((e) => html`<tr><td class="num">${fmtDate(e.spent_on)}</td><td>${CAT[e.category]}</td><td class="num">${money(e.amount)}</td><td class="small">${e.note || ''}</td><td class="small">${e.created_by_name || '—'}</td>
        <td style="text-align:right"><button class="btn sm danger" data-delexp="${e.id}" aria-label="Delete expense">${icon('x')}</button></td></tr>`), 'No expenses recorded yet.')}</section>`);
  root.querySelector('#addexp').onclick = () => formSheet('Add expense', html`<form novalidate>
    <div class="field"><span>Category</span><div class="seg">${d.categories.map((c, n) => html`<label><input type="radio" name="category" value="${c}" ${n === 0 ? raw('checked') : ''}><span>${CAT[c]}</span></label>`)}</div></div>
    <div class="row two"><label class="field"><span>Amount ₹</span><input class="input num" name="amount" inputmode="decimal" required></label>
      <label class="field"><span>Date</span><input class="input" type="date" name="spent_on" value="${todayStr()}"></label></div>
    <label class="field"><span>Note</span><input class="input" name="note" maxlength="200" placeholder="e.g. September rent, 2 technicians"></label>
    <p class="error" hidden></p><button class="btn primary block">Save expense</button></form>`,
  (f) => api('/api/admin/expenses', { method: 'POST', body: formData(f) }), 'Expense saved');
  root.querySelectorAll('[data-delexp]').forEach((b) => { b.onclick = async () => { if (!confirm('Delete this expense?')) return; await api('/api/admin/expenses/' + b.dataset.delexp, { method: 'DELETE' }); route(); }; });
}

// ---------------------------------------------------------------- approvals (Super Admin)
async function viewApprovals() {
  const status = query().get('status') || 'pending';
  const { requests } = await api('/api/admin/discounts?status=' + status);
  shell('#/approvals', html`
    <div class="page-head"><div><span class="eyebrow">Super Admin</span><h1 class="h-display">Discount approvals</h1></div>
      <div class="seg">${['pending', 'approved', 'rejected', 'used'].map((t) => html`<label><input type="radio" name="tab" value="${t}" ${t === status ? raw('checked') : ''}><span>${t}</span></label>`)}</div></div>
    ${table(['Requested', 'Customer', 'Amount', 'Reason', 'By', ''], requests.map((x) => html`<tr><td class="small">${fmtDate(x.created_at.slice(0, 10))}</td>
      <td><a href="#/customer/${x.customer_id}">${x.customer_name || fmtPhone(x.customer_phone)}</a></td><td class="num"><b>${money(x.amount)}</b></td><td>${x.reason || ''}</td><td class="small">${x.requested_by_name || '—'}</td>
      <td style="text-align:right;white-space:nowrap">${x.status === 'pending' ? html`<button class="btn sm primary" data-appr="${x.id}">Approve</button> <button class="btn sm danger" data-rej="${x.id}">Reject</button>` : ''}</td></tr>`), `No ${status} requests.`)}`);
  root.querySelectorAll('[name=tab]').forEach((r) => r.addEventListener('change', () => go('#/approvals?status=' + r.value)));
  root.querySelectorAll('[data-appr]').forEach((b) => { b.onclick = () => {
    const x = requests.find((q) => String(q.id) === b.dataset.appr);
    formSheet('Approve discount', html`<form novalidate><p class="muted" style="margin-bottom:16px">${x.reason}</p>
      <label class="field"><span>Approved amount ₹ (you can lower it)</span><input class="input num" name="amount" inputmode="decimal" value="${x.amount / 100}"></label>
      <p class="error" hidden></p><button class="btn primary block">Approve</button></form>`,
    (f) => api(`/api/admin/discounts/${x.id}/decide`, { method: 'POST', body: { decision: 'approve', amount: f.amount.value } }), 'Approved. The Admin can now create the invoice');
  }; });
  root.querySelectorAll('[data-rej]').forEach((b) => { b.onclick = async () => {
    if (!confirm('Reject this discount request?')) return;
    await busy(b, null, () => api(`/api/admin/discounts/${b.dataset.rej}/decide`, { method: 'POST', body: { decision: 'reject' } })).catch(() => null);
    route();
  }; });
}

// ---------------------------------------------------------------- marketing (Super Admin)
async function viewMarketing() {
  const d = await api('/api/admin/marketing');
  const ig = d.instagram.latest; const yt = d.youtube.latest;
  const metric = (label, value) => html`<div><span class="label">${label}</span><p class="num" style="font-size:20px;font-weight:600;margin-top:4px">${value ?? '—'}</p></div>`;
  shell('#/marketing', html`
    <div class="page-head"><div><span class="eyebrow">Super Admin</span><h1 class="h-display">Marketing</h1></div><button class="btn primary" id="check">Check now</button></div>
    <p class="lede" style="margin:-8px 0 26px;max-width:60ch">The app checks Instagram and YouTube every day. When interaction drops, or you haven’t posted for a while, you get an alert with tips.</p>
    <div class="grid two">
      <div class="card pad-lg"><div class="card-row"><h2 class="h-card grow">Instagram</h2>${d.instagram.connected ? html`<span class="chip ok">Connected</span>` : html`<span class="chip dim">Not connected</span>`}</div>
        ${ig ? html`<p class="muted small" style="margin:6px 0 16px">@${ig.username} · checked ${fmtDate(ig.taken_on)}</p>
          <div class="row two" style="gap:18px">${metric('Followers', ig.metrics.followers)}${metric('Posts, last 14 days', ig.metrics.posts_14d)}
            ${metric('Engagement / post, recent', ig.metrics.er_recent + '%')}${metric('Engagement / post, before', ig.metrics.er_baseline + '%')}</div>
          ${ig.issues.length ? html`<p class="chip warn" style="margin-top:14px">${ig.issues.includes('engagement') ? 'Engagement dropping' : 'Posting gap'}</p>` : html`<p class="chip ok" style="margin-top:14px">Healthy</p>`}`
    : html`<p class="muted small" style="margin:8px 0">No data yet.</p>`}
        <details style="margin-top:18px"><summary class="label" style="cursor:pointer">Connection</summary>
          <form id="igf" novalidate style="margin-top:14px">
            <label class="field"><span>Instagram access token</span><input class="input" name="ig_token" type="password" autocomplete="off" placeholder="${d.instagram.connected ? '•••••• saved (enter to replace)' : 'Paste long-lived token'}"></label>
            <label class="field"><span>Instagram user ID (only for Facebook Login tokens)</span><input class="input" name="ig_user_id" placeholder="leave blank for Instagram Login tokens"></label>
            <p class="error" hidden></p><button class="btn sm primary">Save</button> ${d.instagram.connected ? html`<button type="button" class="btn sm danger" id="igoff">Disconnect</button>` : ''}
          </form>
          <p class="hint" style="margin-top:12px">Needs an Instagram Business or Creator account. In Meta for Developers, create an app with the “Instagram API with Instagram login” product, add the account, and generate a long-lived access token. The app renews it automatically every week.</p></details>
      </div>
      <div class="card pad-lg"><div class="card-row"><h2 class="h-card grow">YouTube</h2>${d.youtube.connected ? html`<span class="chip ok">Connected</span>` : html`<span class="chip dim">Not connected</span>`}</div>
        ${yt ? html`<p class="muted small" style="margin:6px 0 16px">${yt.title} · checked ${fmtDate(yt.taken_on)}</p>
          <div class="row two" style="gap:18px">${metric('Subscribers', yt.metrics.subscribers)}${metric('Videos, last 30 days', yt.metrics.videos_30d)}
            ${metric('Views / video, recent', yt.metrics.views_recent)}${metric('Views / video, before', yt.metrics.views_baseline)}</div>
          ${yt.issues.length ? html`<p class="chip warn" style="margin-top:14px">${yt.issues.includes('engagement') ? 'Interaction dropping' : 'Posting gap'}</p>` : html`<p class="chip ok" style="margin-top:14px">Healthy</p>`}`
    : html`<p class="muted small" style="margin:8px 0">No data yet.</p>`}
        <details style="margin-top:18px"><summary class="label" style="cursor:pointer">Connection</summary>
          <form id="ytf" novalidate style="margin-top:14px">
            <label class="field"><span>YouTube Data API key</span><input class="input" name="yt_api_key" type="password" autocomplete="off" placeholder="${d.youtube.connected ? '•••••• saved (enter to replace)' : 'Google Cloud API key'}"></label>
            <label class="field"><span>Channel ID or @handle</span><input class="input" name="yt_channel" value="${d.youtube.channel}" placeholder="@d24studio or UC…"></label>
            <p class="error" hidden></p><button class="btn sm primary">Save</button>
          </form>
          <p class="hint" style="margin-top:12px">In Google Cloud Console: create a project, enable “YouTube Data API v3”, then create an API key under Credentials.</p></details>
      </div>
    </div>
    <section class="section"><div class="section-head"><h2 class="h-section">This week’s ideas</h2></div>
      <div class="grid two"><div class="card"><p class="label" style="margin-bottom:10px">Instagram</p>${d.tips.instagram.map((t) => html`<p class="small" style="margin-bottom:10px">• ${t}</p>`)}</div>
        <div class="card"><p class="label" style="margin-bottom:10px">YouTube</p>${d.tips.youtube.map((t) => html`<p class="small" style="margin-bottom:10px">• ${t}</p>`)}</div></div></section>`);
  const save = (id, map) => root.querySelector(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = map(f);
    const ok = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => api('/api/admin/marketing/settings', { method: 'POST', body })).catch(() => null);
    if (ok) { toast('Saved. Checking now…'); await api('/api/admin/marketing/check', { method: 'POST' }).then((r) => { const errs = Object.values(r.result).filter((x) => !x.ok).map((x) => x.error); if (errs.length) toast(errs.join(' · '), true); }).catch((er) => toast(er.message, true)); route(); }
  });
  save('#igf', (f) => ({ ...(f.ig_token.value ? { ig_token: f.ig_token.value } : {}), ig_user_id: f.ig_user_id.value }));
  save('#ytf', (f) => ({ ...(f.yt_api_key.value ? { yt_api_key: f.yt_api_key.value } : {}), yt_channel: f.yt_channel.value }));
  const off = root.querySelector('#igoff');
  if (off) off.onclick = async () => { if (!confirm('Disconnect Instagram?')) return; await api('/api/admin/marketing/settings', { method: 'POST', body: { ig_token: '', ig_user_id: '' } }); route(); };
  root.querySelector('#check').onclick = async (e) => {
    const r = await busy(e.currentTarget, null, () => api('/api/admin/marketing/check', { method: 'POST' })).catch(() => null);
    if (!r) return;
    const res = Object.entries(r.result);
    if (!res.length) toast('Connect Instagram or YouTube first', true);
    else { const errs = res.filter(([, x]) => !x.ok); toast(errs.length ? errs.map(([p, x]) => `${p}: ${x.error}`).join(' · ') : 'Checked. Alerts raised if interaction dropped', !!errs.length); }
    route();
  };
}

// ---------------------------------------------------------------- staff (Super Admin)
function staffSection(staff) {
  return html`<section><div class="section-head"><h2 class="h-section">Staff</h2><button class="btn sm primary" id="adds">${icon('plus')} Add staff</button></div>
    <p class="muted small" style="margin:-4px 0 14px;max-width:70ch">Admins handle customers, invoices, payments, bookings and stock received. Only a Super Admin sees revenue, approves discounts, issues warranties and changes mobile numbers.</p>
    ${table(['Name', 'Role', 'Status', ''], staff.map((s) => html`<tr><td><b style="font-weight:600">${s.name}</b>${s.builtin ? html`<br><span class="muted small">Owner PIN (set in Vercel)</span>` : ''}</td>
      <td>${s.role === 'super' ? 'Super Admin' : 'Admin'}</td><td>${s.active ? html`<span class="chip ok">Active</span>` : html`<span class="chip dim">Disabled</span>`}</td>
      <td style="text-align:right;white-space:nowrap">${s.builtin ? '' : html`<button class="btn sm" data-pin="${s.id}">Reset PIN</button> <button class="btn sm ${s.active ? 'danger' : ''}" data-act="${s.id}" data-on="${s.active ? 0 : 1}">${s.active ? 'Disable' : 'Enable'}</button>`}</td></tr>`), '')}</section>`;
}
function wireStaff() {
  root.querySelector('#adds').onclick = () => formSheet('Add staff', html`<form novalidate>
    <label class="field"><span>Name</span><input class="input" name="name" required maxlength="60"></label>
    <div class="field"><span>Role</span><div class="seg"><label><input type="radio" name="role" value="admin" checked><span>Admin</span></label><label><input type="radio" name="role" value="super"><span>Super Admin</span></label></div></div>
    <label class="field"><span>PIN (6–10 digits, unique)</span><input class="input" name="pin" inputmode="numeric" required autocomplete="off"></label>
    <p class="error" hidden></p><button class="btn primary block">Add</button></form>`,
  (f) => api('/api/admin/staff', { method: 'POST', body: formData(f) }), 'Staff added. Share the PIN with them privately');
  root.querySelectorAll('[data-pin]').forEach((b) => { b.onclick = () => formSheet('Reset PIN', html`<form novalidate>
    <label class="field"><span>New PIN (6–10 digits)</span><input class="input" name="pin" inputmode="numeric" required autocomplete="off"></label>
    <p class="error" hidden></p><button class="btn primary block">Save</button></form>`,
  (f) => api('/api/admin/staff/' + b.dataset.pin, { method: 'PATCH', body: formData(f) }), 'PIN updated'); });
  root.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => {
    await busy(b, null, () => api('/api/admin/staff/' + b.dataset.act, { method: 'PATCH', body: { active: b.dataset.on === '1' } })).catch(() => null);
    route();
  }; });
}

// ---------------------------------------------------------------- brands (Super Admin)
async function viewSettings() {
  const [{ brands }, { staff }] = await Promise.all([api('/api/admin/brands'), api('/api/admin/staff')]);
  shell('#/settings', html`
    <div class="page-head"><div><span class="eyebrow">Super Admin</span><h1 class="h-display">Settings</h1></div></div>
    ${staffSection(staff)}
    <section class="section"><div class="section-head"><h2 class="h-section">Warranty brands</h2></div>
    <p class="muted small" style="margin:-4px 0 14px">Brands offered on warranty certificates. Add new ones as the studio takes them on.</p>
    <div class="grid side">
      ${table(['Brand', 'Ceramic', 'PPF'], brands.map((b) => html`<tr><td><b style="font-weight:600">${b.name}</b></td><td>${b.ceramic ? icon('check', 'chev') : html`<span class="muted">—</span>`}</td><td>${b.ppf ? icon('check', 'chev') : html`<span class="muted">—</span>`}</td></tr>`), '')}
      <form id="bf" class="card" novalidate><h2 class="h-card" style="margin-bottom:16px">Add or update a brand</h2>
        <label class="field"><span>Brand name</span><input class="input" name="name" required maxlength="40"></label>
        <div class="field"><span>Used for</span><label class="small"><input type="checkbox" name="ceramic"> Ceramic coating</label><label class="small"><input type="checkbox" name="ppf"> Paint protection film</label></div>
        <p class="error" hidden></p><button class="btn primary block">Save brand</button></form>
    </div></section>`);
  wireStaff();
  const f = root.querySelector('#bf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => api('/api/admin/brands', { method: 'POST', body: { name: f.name.value, ceramic: f.ceramic.checked, ppf: f.ppf.checked } })).catch(() => null);
    if (out) { toast('Brand saved'); viewSettings(); }
  });
}

boot();
