import {
  html, raw, api, icon, toast, sheet, busy, formData, money, fmtDate, fmtPhone, todayStr, relDays,
  kindName, serviceChip, healthChip, bookingChip,
} from './core.js';

const root = document.getElementById('app');
const A = { services: [], gstRate: 18, brands: [] };
const NAV = [['#/', 'Overview'], ['#/customers', 'Customers'], ['#/bookings', 'Bookings'], ['#/settings', 'Brands']];

async function boot() {
  try {
    const s = await api('/api/admin/session');
    A.services = s.services; A.gstRate = s.gstRate;
  } catch (e) {
    if (e.status === 401) return renderLogin();
    root.innerHTML = '<p style="padding:40px">Server unavailable.</p>';
    return;
  }
  route();
}

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
async function route() {
  const h = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const [a, b] = h.split('/').filter(Boolean);
  try {
    if (!a) return await viewOverview();
    if (a === 'customers') return await viewCustomers();
    if (a === 'customer' && b) return await viewCustomer(b);
    if (a === 'bookings') return await viewBookings();
    if (a === 'settings') return await viewSettings();
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
    <span class="label" style="border-left:1px solid var(--rule);padding-left:14px">Staff</span>
    <nav class="topnav admin-nav">${NAV.map(([href, l]) => html`<a href="${href}" class="${active === href ? 'on' : ''}">${l}</a>`)}</nav>
    <div class="actions"><button class="icon-btn" id="out" aria-label="Sign out" title="Sign out">${icon('logout')}</button></div>
  </div></header>
  <main style="padding-bottom:64px"><div class="wrap fade-in">${content}</div></main>`.s;
  root.querySelector('#out').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); renderLogin(); };
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
    if (ok) boot();
  });
}

const who = (r) => html`<b style="font-weight:600">${r.customer_name || 'Unnamed'}</b><br><span class="muted small num">${fmtPhone(r.customer_phone)}</span>`;

function bookingActions(b) {
  const acts = { requested: [['confirmed', 'Confirm', 'primary'], ['cancelled', 'Decline', 'danger']], confirmed: [['completed', 'Complete', 'primary'], ['cancelled', 'Cancel', 'danger']] }[b.status] || [];
  return html`<div style="display:flex;gap:6px;justify-content:flex-end">${acts.map(([st, l, c]) => html`<button class="btn sm ${c}" data-bk="${b.id}" data-st="${st}">${l}</button>`)}</div>`;
}

// global handler for booking + service status buttons
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-bk],[data-svc-st],[data-inv-paid]');
  if (!b) return;
  if (b.dataset.bk) {
    if (b.dataset.st === 'cancelled' && !confirm('Cancel this booking? The customer will be notified.')) return;
    await busy(b, null, () => api(`/api/admin/bookings/${b.dataset.bk}/status`, { method: 'POST', body: { status: b.dataset.st } })).catch(() => null);
    toast('Booking ' + b.dataset.st);
  } else if (b.dataset.svcSt) {
    await busy(b, null, () => api(`/api/admin/services/${b.dataset.svcId}/status`, { method: 'POST', body: { status: b.dataset.svcSt } })).catch(() => null);
    toast('Service updated');
  } else if (b.dataset.invPaid) {
    await busy(b, null, () => api(`/api/admin/invoices/${b.dataset.invPaid}`, { method: 'PATCH', body: { status: b.dataset.to } })).catch(() => null);
    toast('Invoice updated');
  }
  route();
});

// ------------------------------------------------------------ overview
async function viewOverview() {
  const d = await api('/api/admin/overview');
  const svcTable = (rows, empty) => rows.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>Customer</th><th>Vehicle</th><th>Service</th><th>Due</th><th></th></tr></thead><tbody>
    ${rows.map((s) => html`<tr class="click" data-href="#/customer/${s.customer_id}"><td>${who(s)}</td><td>${s.make} ${s.model}<br><span class="plate" style="font-size:11px">${s.reg_no}</span></td><td>${s.title}</td>
    <td class="num">${fmtDate(s.due_on)}<br><span class="muted small">${relDays(s.days)}</span></td><td style="text-align:right"><a class="btn sm" href="tel:${s.customer_phone}">${icon('phone')} Call</a></td></tr>`)}</tbody></table></div>`
    : html`<div class="empty small">${empty}</div>`;
  const bkTable = (rows, empty) => rows.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Customer</th><th>Vehicle</th><th>Service</th><th></th></tr></thead><tbody>
    ${rows.map((b) => html`<tr><td class="num"><b>${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${b.slot}</td><td>${who(b)}</td><td>${b.vehicle_label}<br><span class="plate" style="font-size:11px">${b.vehicle.reg_no}</span></td>
    <td>${b.service}${b.notes ? html`<br><span class="muted small">“${b.notes}”</span>` : ''}</td><td>${bookingActions(b)}</td></tr>`)}</tbody></table></div>`
    : html`<div class="empty small">${empty}</div>`;

  shell('#/', html`
    <div class="page-head"><div><span class="eyebrow">${fmtDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })}</span><h1 class="h-display">Overview</h1></div>
      <a class="btn primary" href="#/customers?new=1">${icon('plus')} New customer</a></div>
    <div class="grid three">
      <div class="stat"><span class="label">Customers</span><b class="num">${d.counts.customers}</b></div>
      <div class="stat"><span class="label">Active warranties</span><b class="num">${d.counts.active_warranties}</b></div>
      <div class="stat"><span class="label">Invoiced this month</span><b class="num">${money(d.counts.revenue_month)}</b></div>
    </div>
    <section class="section"><div class="section-head"><h2 class="h-section">Booking requests</h2><span class="muted small">${d.requests.length}</span></div>${bkTable(d.requests, 'No pending requests.')}</section>
    <section class="section"><div class="section-head"><h2 class="h-section">Next 7 days</h2></div>${bkTable(d.schedule, 'Nothing confirmed for the coming week.')}</section>
    <section class="section"><div class="section-head"><h2 class="h-section" style="color:#ff6a55">Missed services</h2><span class="muted small">${d.missed.length}</span></div>${svcTable(d.missed, 'No missed services.')}</section>
    <section class="section"><div class="section-head"><h2 class="h-section">Due soon</h2><span class="muted small">${d.due_soon.length}</span></div>${svcTable(d.due_soon, 'Nothing due in the next two weeks.')}</section>`);
  bindRowLinks();
}

function bindRowLinks() {
  root.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) location.hash = tr.dataset.href; }));
}

// ------------------------------------------------------------ customers
async function viewCustomers(q = '') {
  const { customers } = await api('/api/admin/customers?q=' + encodeURIComponent(q));
  shell('#/customers', html`
    <div class="page-head"><div><span class="eyebrow">Directory</span><h1 class="h-display">Customers</h1></div><button class="btn primary" id="new">${icon('plus')} New customer</button></div>
    <form id="sf" style="display:flex;gap:8px;margin-bottom:18px"><input class="input" name="q" placeholder="Search name, mobile or registration" value="${q}"><button class="btn">${icon('search')}</button></form>
    ${customers.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Mobile</th><th>Vehicles</th><th>Since</th></tr></thead><tbody>
      ${customers.map((c) => html`<tr class="click" data-href="#/customer/${c.id}"><td><b style="font-weight:600">${c.name || 'Unnamed (not signed in yet)'}</b>${c.email ? html`<br><span class="muted small">${c.email}</span>` : ''}</td>
      <td class="num">${fmtPhone(c.phone)}</td><td>${c.regs || html`<span class="muted">—</span>`}</td><td class="muted small">${fmtDate(c.created_at.slice(0, 10))}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">No customers match.</div>`}`);
  bindRowLinks();
  const sf = root.querySelector('#sf');
  sf.addEventListener('submit', (e) => { e.preventDefault(); viewCustomers(sf.q.value); });
  root.querySelector('#new').onclick = newCustomer;
  if (location.hash.includes('new=1')) { history.replaceState(null, '', '#/customers'); newCustomer(); }
}

function newCustomer() {
  const sh = sheet('New customer', html`<form id="cf" novalidate>
    <label class="field"><span>Mobile number</span><input class="input" name="phone" type="tel" inputmode="numeric" required placeholder="98765 43210"></label>
    <label class="field"><span>Name</span><input class="input" name="name" maxlength="80"></label>
    <label class="field"><span>Email (optional)</span><input class="input" name="email" type="email" maxlength="120"></label>
    <p class="hint" style="margin-bottom:16px">The customer signs in with this number using an SMS code.</p>
    <p class="error" hidden></p><button class="btn primary block">Create</button></form>`);
  const f = sh.el.querySelector('#cf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => api('/api/admin/customers', { method: 'POST', body: formData(f) })).catch(() => null);
    if (out) { sh.close(); toast(out.existed ? 'Customer already exists: opening record' : 'Customer created'); go('#/customer/' + out.customer.id); }
  });
}

// ------------------------------------------------------------ customer detail
async function viewCustomer(id) {
  const [d, { brands }] = await Promise.all([api('/api/admin/customers/' + id), api('/api/admin/brands')]);
  A.brands = brands;
  const c = d.customer;
  const vOpts = (sel) => d.vehicles.map((v) => html`<option value="${v.id}" ${String(sel) === String(v.id) ? raw('selected') : ''}>${v.make} ${v.model} · ${v.reg_no}</option>`);
  const head = (title, btnId, label, disabled) => html`<div class="section-head"><h2 class="h-section">${title}</h2>${btnId ? html`<button class="btn sm" id="${btnId}" ${disabled ? raw('disabled title="Add a vehicle first"') : ''}>${icon('plus')} ${label}</button>` : ''}</div>`;

  shell('#/customers', html`
    <a class="back" href="#/customers">${icon('left')} Customers</a>
    <div class="page-head"><div><span class="eyebrow">Customer</span><h1 class="h-display">${c.name || 'Unnamed'}</h1>
      <p class="muted" style="margin-top:8px">${fmtPhone(c.phone)}${c.email ? ' · ' + c.email : ''}</p></div>
      <div style="display:flex;gap:8px"><a class="btn sm" href="tel:${c.phone}">${icon('phone')} Call</a><button class="btn sm" id="editc">${icon('edit')} Edit</button></div></div>

    <section>${head('Vehicles', 'addv', 'Add vehicle')}
      ${d.vehicles.length ? html`<div class="grid three">${d.vehicles.map((v) => html`<div class="card"><p class="h-card">${v.make} ${v.model}</p><p class="muted small">${v.kind === 'bike' ? 'Motorcycle' : 'Car'}${v.year ? ' · ' + v.year : ''}${v.colour ? ' · ' + v.colour : ''}</p><p style="margin-top:10px"><span class="plate">${v.reg_no}</span></p></div>`)}</div>`
        : html`<div class="empty small">No vehicles yet.</div>`}</section>

    <section class="section">${head('Invoices', 'addi', 'New invoice')}
      ${d.invoices.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>No.</th><th>Date</th><th>Vehicle</th><th>Items</th><th style="text-align:right">Total</th><th>Status</th></tr></thead><tbody>
        ${d.invoices.map((i) => html`<tr><td class="mono">${i.invoice_no}</td><td class="num">${fmtDate(i.issued_on)}</td><td>${i.vehicle_label || '—'}</td><td class="small">${i.items.map((x) => x.desc).join('; ')}</td>
        <td class="num" style="text-align:right;font-weight:600">${money(i.total)}</td>
        <td>${i.status === 'paid' ? html`<span class="chip ok">Paid</span>` : html`<button class="btn sm" data-inv-paid="${i.id}" data-to="paid">Mark paid</button>`}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty small">No invoices.</div>`}</section>

    <section class="section">${head('Warranties', 'addw', 'Issue warranty', !d.vehicles.length)}
      ${d.warranties.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>Certificate</th><th>Type</th><th>Brand / product</th><th>Vehicle</th><th>Valid</th><th>Status</th></tr></thead><tbody>
        ${d.warranties.map((w) => html`<tr><td class="mono">${w.cert_no}</td><td>${kindName(w.kind)}</td><td><b style="font-weight:600">${w.brand}</b><br><span class="muted small">${w.product}</span></td><td>${w.vehicle_label}</td>
        <td class="num small">${fmtDate(w.starts_on)} – ${fmtDate(w.ends_on)}<br><span class="muted">every ${w.interval_months} mo</span></td><td>${healthChip(w.health)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty small">No warranties.</div>`}</section>

    <section class="section">${head('Service schedule', 'adds', 'Add service date', !d.vehicles.length)}
      ${d.services.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>Due</th><th>Service</th><th>Vehicle</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.services.map((s) => html`<tr><td class="num">${fmtDate(s.due_on)}${s.status === 'due' ? html`<br><span class="muted small">${relDays(s.days)}</span>` : ''}</td><td>${s.title}${s.done_on ? html`<br><span class="muted small">done ${fmtDate(s.done_on)}</span>` : ''}</td>
        <td>${s.make} ${s.model}</td><td>${serviceChip(s)}</td>
        <td style="text-align:right;white-space:nowrap">${s.status === 'due' || s.status === 'booked'
          ? html`<button class="btn sm" data-svc-st="done" data-svc-id="${s.id}">Mark done</button> <button class="btn sm danger" data-svc-st="skipped" data-svc-id="${s.id}">Skip</button>`
          : html`<button class="btn sm" data-svc-st="due" data-svc-id="${s.id}">Reopen</button>`}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty small">No service dates.</div>`}</section>

    <section class="section">${head('Bookings')}
      ${d.bookings.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Service</th><th>Vehicle</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.bookings.map((b) => html`<tr><td class="num">${fmtDate(b.date)}<br>${b.slot}</td><td>${b.service}${b.notes ? html`<br><span class="muted small">“${b.notes}”</span>` : ''}</td><td>${b.vehicle_label}</td><td>${bookingChip(b.status)}</td><td>${bookingActions(b)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty small">No bookings.</div>`}</section>`);

  const reload = () => viewCustomer(id);
  const submitSheet = (title, body, url, map, msg) => {
    const sh = sheet(title, body);
    const f = sh.el.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = await busy(f.querySelector('button.primary'), f.querySelector('.error'), () => api(url, { method: 'POST', body: map(f) })).catch(() => null);
      if (out) { sh.close(); toast(msg); reload(); }
    });
    return sh;
  };

  root.querySelector('#editc').onclick = () => {
    const sh = sheet('Edit customer', html`<form novalidate><label class="field"><span>Name</span><input class="input" name="name" value="${c.name || ''}"></label>
      <label class="field"><span>Email</span><input class="input" name="email" type="email" value="${c.email || ''}"></label><p class="error" hidden></p><button class="btn primary block">Save</button></form>`);
    const f = sh.el.querySelector('form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => api('/api/admin/customers/' + c.id, { method: 'PATCH', body: formData(f) })).catch(() => null);
      if (out) { sh.close(); reload(); }
    });
  };

  root.querySelector('#addv').onclick = () => submitSheet('Add vehicle', html`<form novalidate>
    <div class="field"><span>Type</span><div class="seg"><label><input type="radio" name="kind" value="car" checked><span>Car</span></label><label><input type="radio" name="kind" value="bike"><span>Motorcycle</span></label></div></div>
    <div class="row two"><label class="field"><span>Make</span><input class="input" name="make" required></label><label class="field"><span>Model</span><input class="input" name="model" required></label></div>
    <label class="field"><span>Registration</span><input class="input" name="reg_no" required style="text-transform:uppercase"></label>
    <div class="row two"><label class="field"><span>Year</span><input class="input" name="year" inputmode="numeric"></label><label class="field"><span>Colour</span><input class="input" name="colour"></label></div>
    <p class="error" hidden></p><button class="btn primary block">Add vehicle</button></form>`, `/api/admin/customers/${c.id}/vehicles`, formData, 'Vehicle added');

  root.querySelector('#addi').onclick = () => {
    const line = () => html`<div class="items-grid"><input class="input" name="desc" placeholder="Description" list="svc-list"><input class="input num" name="qty" value="1" inputmode="numeric"><input class="input num" name="rate" placeholder="₹ rate" inputmode="decimal"><button type="button" class="icon-btn" data-rm aria-label="Remove line">${icon('x')}</button></div>`;
    const sh = submitSheet('New invoice', html`<form novalidate>
      <div class="row two"><label class="field"><span>Vehicle</span><select class="input" name="vehicle_id"><option value="">—</option>${vOpts(d.vehicles[0]?.id)}</select></label>
        <label class="field"><span>Date</span><input class="input" type="date" name="issued_on" value="${todayStr()}"></label></div>
      <div class="field"><span>Line items (rates exclude GST)</span><div id="lines">${line()}${line()}</div>
        <button type="button" class="btn sm" id="addline">${icon('plus')} Add line</button></div>
      <datalist id="svc-list">${A.services.map((s) => html`<option value="${s}">`)}</datalist>
      <div class="row three"><label class="field"><span>Discount ₹</span><input class="input num" name="discount" value="0" inputmode="decimal"></label>
        <label class="field"><span>GST %</span><input class="input num" name="tax_rate" value="${A.gstRate}" inputmode="decimal"></label>
        <label class="field"><span>Status</span><select class="input" name="status"><option value="paid">Paid</option><option value="due">Due</option></select></label></div>
      <label class="field"><span>Payment mode</span><select class="input" name="payment_mode"><option>UPI</option><option>Card</option><option>Cash</option><option>Bank transfer</option></select></label>
      <label class="field"><span>Notes</span><textarea class="input" name="notes" maxlength="500"></textarea></label>
      <p class="hint" id="calc" style="margin-bottom:12px"></p>
      <p class="error" hidden></p><button class="btn primary block">Create invoice</button></form>`,
    '/api/admin/invoices', (f) => {
      const items = [...f.querySelectorAll('.items-grid')].map((r) => ({ desc: r.querySelector('[name=desc]').value, qty: r.querySelector('[name=qty]').value, rate: r.querySelector('[name=rate]').value }));
      return { customer_id: c.id, vehicle_id: f.vehicle_id.value || null, issued_on: f.issued_on.value, items, discount: f.discount.value, tax_rate: f.tax_rate.value, status: f.status.value, payment_mode: f.payment_mode.value, notes: f.notes.value };
    }, 'Invoice created. The customer has been notified');
    const f = sh.el.querySelector('form');
    const calc = () => {
      const sub = [...f.querySelectorAll('.items-grid')].reduce((s, r) => s + (Number(r.querySelector('[name=qty]').value) || 0) * (Number(r.querySelector('[name=rate]').value) || 0), 0);
      const net = Math.max(0, sub - (Number(f.discount.value) || 0));
      const total = net * (1 + (Number(f.tax_rate.value) || 0) / 100);
      f.querySelector('#calc').textContent = `Subtotal ${money(sub * 100)} · Total incl. GST ${money(Math.round(total * 100))}`;
    };
    f.addEventListener('input', calc);
    f.querySelector('#addline').onclick = () => { f.querySelector('#lines').insertAdjacentHTML('beforeend', line().s); };
    f.addEventListener('click', (e) => { const rm = e.target.closest('[data-rm]'); if (rm && f.querySelectorAll('.items-grid').length > 1) { rm.parentElement.remove(); calc(); } });
    calc();
  };

  const wBtn = root.querySelector('#addw');
  wBtn.onclick = () => {
    const sh = submitSheet('Issue warranty', html`<form novalidate>
      <label class="field"><span>Vehicle</span><select class="input" name="vehicle_id">${vOpts()}</select></label>
      <div class="field"><span>Type</span><div class="seg"><label><input type="radio" name="kind" value="ceramic" checked><span>Ceramic coating</span></label><label><input type="radio" name="kind" value="ppf"><span>PPF</span></label></div></div>
      <div class="row two"><label class="field"><span>Brand</span><select class="input" name="brand"></select></label>
        <label class="field"><span>Product / package</span><input class="input" name="product" list="prod-list" required placeholder="e.g. Signature coat (9H)"></label></div>
      <datalist id="prod-list"></datalist>
      <label class="field"><span>Coverage</span><input class="input" name="coverage" placeholder="e.g. Full body paint, glass and wheels"></label>
      <div class="row three"><label class="field"><span>Applied on</span><input class="input" type="date" name="starts_on" value="${todayStr()}"></label>
        <label class="field"><span>Years</span><input class="input num" name="years" value="3" inputmode="numeric"></label>
        <label class="field"><span>Inspection every (months)</span><input class="input num" name="interval_months" value="6" inputmode="numeric"></label></div>
      <label class="field"><span>Linked invoice</span><select class="input" name="invoice_id"><option value="">—</option>${d.invoices.map((i) => html`<option value="${i.id}">${i.invoice_no} · ${fmtDate(i.issued_on)} · ${money(i.total)}</option>`)}</select></label>
      <label class="field"><span>Terms (leave blank for standard terms)</span><textarea class="input" name="terms" maxlength="2000"></textarea></label>
      <p class="hint" style="margin-bottom:12px">Inspection dates for the full term are scheduled automatically, and the customer gets reminders before each one.</p>
      <p class="error" hidden></p><button class="btn primary block">Issue certificate</button></form>`,
    '/api/admin/warranties', (f) => ({ ...formData(f), customer_id: c.id }), 'Warranty issued');
    const f = sh.el.querySelector('form');
    const PRODUCTS = { ceramic: ['Essential coat', 'Signature coat (9H)', 'Wheel & glass coating'], ppf: ['Gloss PPF: full body', 'Gloss PPF: front kit', 'Matte PPF: full body', 'Gloss PPF, 190 micron'] };
    const sync = () => {
      const k = f.kind.value;
      f.brand.innerHTML = A.brands.filter((b) => b[k]).map((b) => html`<option>${b.name}</option>`.s).join('');
      f.querySelector('#prod-list').innerHTML = PRODUCTS[k].map((p) => html`<option value="${p}">`.s).join('');
      f.years.value = k === 'ppf' ? 5 : 3; f.interval_months.value = k === 'ppf' ? 12 : 6;
    };
    f.querySelectorAll('[name=kind]').forEach((r) => r.addEventListener('change', sync));
    sync();
  };

  root.querySelector('#adds').onclick = () => submitSheet('Add service date', html`<form novalidate>
    <label class="field"><span>Vehicle</span><select class="input" name="vehicle_id">${vOpts()}</select></label>
    <label class="field"><span>Service</span><input class="input" name="title" list="svc-list2" required value="Maintenance wash"></label>
    <datalist id="svc-list2">${A.services.map((s) => html`<option value="${s}">`)}</datalist>
    <label class="field"><span>Due on</span><input class="input" type="date" name="due_on" required></label>
    <p class="error" hidden></p><button class="btn primary block">Add</button></form>`,
  '/api/admin/services', (f) => ({ ...formData(f), customer_id: c.id }), 'Service date added');
}

// ------------------------------------------------------------ bookings
async function viewBookings() {
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || 'requested';
  const { bookings } = await api('/api/admin/bookings?status=' + status);
  const tabs = ['requested', 'confirmed', 'completed', 'cancelled'];
  shell('#/bookings', html`
    <div class="page-head"><div><span class="eyebrow">Appointments</span><h1 class="h-display">Bookings</h1></div>
      <div class="seg">${tabs.map((t) => html`<label><input type="radio" name="tab" value="${t}" ${t === status ? raw('checked') : ''}><span>${t}</span></label>`)}</div></div>
    ${bookings.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Customer</th><th>Vehicle</th><th>Service</th><th>Status</th><th></th></tr></thead><tbody>
      ${bookings.map((b) => html`<tr class="click" data-href="#/customer/${b.customer_id}"><td class="num"><b>${fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${b.slot}</td><td>${who(b)}</td>
      <td>${b.vehicle_label}<br><span class="plate" style="font-size:11px">${b.vehicle.reg_no}</span></td><td>${b.service}${b.notes ? html`<br><span class="muted small">“${b.notes}”</span>` : ''}</td>
      <td>${bookingChip(b.status)}</td><td>${bookingActions(b)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">No ${status} bookings.</div>`}`);
  bindRowLinks();
  root.querySelectorAll('[name=tab]').forEach((r) => r.addEventListener('change', () => go('#/bookings?status=' + r.value)));
}

// ------------------------------------------------------------ brands
async function viewSettings() {
  const { brands } = await api('/api/admin/brands');
  shell('#/settings', html`
    <div class="page-head"><div><span class="eyebrow">Settings</span><h1 class="h-display">Brands</h1></div></div>
    <p class="lede" style="margin:-8px 0 24px">Brands offered on warranty certificates. Add new ones as the studio takes them on.</p>
    <div class="grid side">
      <div class="table-wrap"><table class="t"><thead><tr><th>Brand</th><th>Ceramic</th><th>PPF</th></tr></thead><tbody>
        ${brands.map((b) => html`<tr><td><b style="font-weight:600">${b.name}</b></td><td>${b.ceramic ? icon('check', 'chev') : html`<span class="muted">—</span>`}</td><td>${b.ppf ? icon('check', 'chev') : html`<span class="muted">—</span>`}</td></tr>`)}</tbody></table></div>
      <form id="bf" class="card" novalidate><h2 class="h-card" style="margin-bottom:16px">Add or update a brand</h2>
        <label class="field"><span>Brand name</span><input class="input" name="name" required maxlength="40"></label>
        <div class="field"><span>Used for</span><label class="small"><input type="checkbox" name="ceramic"> Ceramic coating</label><label class="small"><input type="checkbox" name="ppf"> Paint protection film</label></div>
        <p class="error" hidden></p><button class="btn primary block">Save brand</button></form>
    </div>`);
  const f = root.querySelector('#bf');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = await busy(f.querySelector('.primary'), f.querySelector('.error'), () => api('/api/admin/brands', { method: 'POST', body: { name: f.name.value, ceramic: f.ceramic.checked, ppf: f.ppf.checked } })).catch(() => null);
    if (out) { toast('Brand saved'); viewSettings(); }
  });
}

boot();
