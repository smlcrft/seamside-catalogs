// Storefront's page. Everything it knows comes from its own server half
// (`/api/…`): a buyer is a stranger and reads no table, and a member's acts
// are checked there, so this page is the same page wherever it was opened.
import '/lib/js/framelib.js';

const { ready, prefs, signIn } = window.seamside;
const SEATED = window !== window.parent;
const page = document.getElementById('page');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  tab: 'shop', shop: null, items: [], ways: [], you: {},
  cart: new Map(), buyer: '', note: '',
  order: null, hand: null, waysFor: [],
  orders: [], setup: null, editing: null, draft: null, look: null,
  error: '', busy: '',
};

async function api(method, path, body) {
  const r = await window.seamside.fetch(`/api${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  let v = {};
  try { v = r.json(); } catch { /* the status says it */ }
  if (!r.ok) throw new Error(v.error || 'Something went wrong. Try again.');
  return v;
}

const places = (c) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits ?? 2;
const money = (minor, c = S.shop.currency) => new Intl.NumberFormat('en', { style: 'currency', currency: c }).format(minor / 10 ** places(c));
const minorOf = (text, c = S.shop.currency) => Math.max(0, Math.round((parseFloat(String(text).replace(/[^0-9.]/g, '')) || 0) * 10 ** places(c)));
const total = () => S.items.reduce((t, i) => t + i.price * (S.cart.get(i.id) ?? 0), 0);
const STATUS = { pending: 'Not paid', awaiting: 'Waiting for payment', paid: 'Paid', cancelled: 'Cancelled', expired: 'Expired' };
const WAY = { stripe: 'Stripe', square: 'Square', paypal: 'PayPal', venmo: 'Venmo', cashapp: 'Cash App', zelle: 'Zelle' };
const when = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ------------------------------------------------------------------ drawing

function draw() {
  const tabs = S.you.member ? `<nav class="seg" aria-label="Pages">${[
    ['shop', 'Shop'], ['orders', 'Orders'], ...(S.you.editor ? [['menu', 'Menu'], ['setup', 'Setup']] : []),
  ].map(([id, name]) => `<button data-tab="${id}" aria-pressed="${S.tab === id}">${name}${id === 'orders' && waiting() ? `<span class="count tnum">${waiting()}</span>` : ''}</button>`).join('')}</nav>` : '';
  const body = { shop: drawShop, orders: drawOrders, menu: drawMenu, setup: drawSetup }[S.tab]();
  const logo = S.shop.logo ? `<img class="logo" alt="" data-pic="${esc(S.shop.logo)}" data-of="shop">` : '';
  page.innerHTML = `<header><div class="brand">${logo}<div><h1>${esc(S.shop.name || 'Storefront')}</h1>${S.shop.note ? `<p>${esc(S.shop.note)}</p>` : ''}</div></div>${tabs}</header>${body}${foot()}`;
  document.title = S.shop.name || 'Storefront';
  wear(S.look?.color ?? S.shop.color);
  hang();
  document.body.dataset.live = '1';
}

// The shop's colour is one of the theme's twelve channels, by name: the
// person's own theme decides what that channel looks like.
function wear(c) {
  const n = /^c([1-9]|1[0-2])$/.test(c ?? '') ? c : 'c4';
  document.body.style.setProperty('--ch', `var(--os-${n})`);
  document.body.style.setProperty('--ch-fg', `var(--os-${n}-fg)`);
}

// A picture is asked of the worker like anything else, since a page has no
// network and a buyer reads no file of the space: once per name, then kept.
// `of` says which table it sits beside: an item's the offerings, the logo the shop.
const pics = new Map();
const pic = (of, name) => {
  const at = `${of}/${name}`;
  if (!pics.has(at)) {
    pics.set(at, window.seamside.fetch(`/api/image/${of}/${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? URL.createObjectURL(new Blob([r.bytes()], { type: r.type })) : ''))
      .catch(() => ''));
  }
  return pics.get(at);
};
function hang() {
  for (const img of page.querySelectorAll('img[data-pic]')) {
    pic(img.dataset.of || 'offerings', img.dataset.pic).then((url) => { if (url && img.isConnected) img.src = url; else if (!url) img.hidden = true; });
  }
}
const thumb = (name) => (name ? `<img class="thumb" alt="" data-pic="${esc(name)}">` : '');

// The picture a person chose, made small before it is sent: a phone's photo
// is several megabytes and a menu shows it at a thumb's size.
async function shrunk(file, edge) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('That file is not a picture this shop can show.');
  const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bmp.width * k)), height: Math.max(1, Math.round(bmp.height * k)) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  for (const [type, q] of [['image/webp', 0.86], ['image/png', 1], ['image/jpeg', 0.86]]) {
    const b = await new Promise((ok) => c.toBlob(ok, type, q));
    if (b && b.type === type && b.size <= 1024 * 1024) return new Uint8Array(await b.arrayBuffer());
  }
  throw new Error('That picture is too large, even made smaller.');
}
async function keepPicture(of, file, edge) {
  const r = await window.seamside.fetch(`/api/image/${of}`, { method: 'PUT', body: await shrunk(file, edge) });
  let v = {};
  try { v = r.json(); } catch { /* the status says it */ }
  if (!r.ok) throw new Error(v.error || 'The picture could not be kept. Try again.');
  return v.name;
}
// the cell a picture is set in: empty, it offers one; set, it shows it with a way to take it away
const cell = (what, name, label) => `<div class="pic" data-pic-for="${what}">${name
  ? `<img alt="" data-pic="${esc(name)}" data-of="${what === 'logo' ? 'shop' : 'offerings'}"><button class="x" data-unpic="${what}" aria-label="Remove the ${label}" title="Remove">×</button>`
  : `<button class="ghost choose" data-pick="${what}" aria-label="Add a ${label}"><i class="ph-light ph-image" aria-hidden="true"></i></button>`}
  <input type="file" accept="image/png,image/jpeg,image/webp" hidden data-file="${what}"></div>`;

const waiting = () => S.orders.filter((o) => o.status === 'awaiting').length;
const foot = () => (S.you.member || S.order ? '' : '<footer>Run this shop? <button class="ghost" data-act="signin">Sign in</button></footer>');
const said = () => (S.error ? `<p class="err" role="alert">${esc(S.error)}</p>` : '');

function drawShop() {
  if (S.order) return drawOrder();
  if (!S.items.length) {
    return `<section><p class="quiet">${S.you.editor ? 'Nothing is for sale yet.' : 'Nothing is for sale right now.'}</p>${S.you.editor ? '<p><button data-tab="menu">Add an item</button></p>' : ''}</section>`;
  }
  const rows = S.items.filter((i) => i.available).map((i) => {
    const n = S.cart.get(i.id) ?? 0;
    const sold = [i.min_qty > 1 ? `${i.min_qty} or more` : '', i.max_qty ? `up to ${i.max_qty}` : ''].filter(Boolean).join(', ');
    return `<li>${thumb(i.image)}<div class="what"><b>${esc(i.name)}</b>${i.description ? `<span>${esc(i.description)}</span>` : ''}${sold ? `<span class="quiet">${sold}</span>` : ''}</div>
      <span class="price tnum">${money(i.price)}</span>
      <span class="qty"><button class="secondary" data-less="${esc(i.id)}" aria-label="Fewer ${esc(i.name)}" ${n ? '' : 'disabled'}>−</button><output class="tnum">${n}</output><button class="secondary" data-more="${esc(i.id)}" aria-label="More ${esc(i.name)}" ${i.max_qty && n >= i.max_qty ? 'disabled' : ''}>+</button></span></li>`;
  }).join('');
  const closed = !S.shop.open;
  const sum = total();
  const card = closed
    ? '<div class="card"><h3>Not taking orders right now</h3><p>The menu is here to look at. Come back when the shop is open.</p></div>'
    : !S.ways.length
      ? `<div class="card"><h3>Not taking payments yet</h3><p>${S.you.editor ? 'Choose how you are paid on the Setup page.' : 'This shop has not set up a way to pay.'}</p>${S.you.editor ? '<div class="acts"><button class="secondary" data-tab="setup">Open Setup</button></div>' : ''}</div>`
      : `<div class="card"><div class="total"><span>Total</span><b class="tnum">${money(sum)}</b></div>
        <div class="fields"><div class="field"><label for="buyer">Name for the order</label><input id="buyer" autocomplete="name" maxlength="80" value="${esc(S.buyer)}"></div>
        <div class="field"><label for="note">Note</label><input id="note" maxlength="280" placeholder="Optional" value="${esc(S.note)}"></div></div>
        ${said()}<div class="acts"><button data-act="order" ${sum && !S.busy ? '' : 'disabled'}>${S.busy === 'order' ? 'Placing…' : 'Place order'}</button></div></div>`;
  return `<section><h2>Menu</h2><ul class="rows">${rows}</ul></section><section>${card}</section>`;
}

function drawOrder() {
  const o = S.order;
  const head = `<div class="total"><span>Order <code class="order">${esc(o.code)}</code></span><b class="tnum">${money(o.total, o.currency)}</b></div><p>${esc(o.summary)}</p>`;
  if (o.status === 'paid') {
    // celebrated once, the moment it is seen paid, and not again on every redraw
    const fresh = S.celebrated !== o.code;
    S.celebrated = o.code;
    return `<section><div class="card paid${fresh ? ' arrives' : ''}"><h3><span class="tick" aria-hidden="true">✓</span>Paid. Thank you.</h3>${head}<p>Keep the order code. It is how the shop finds your order.</p><div class="acts"><button class="secondary" data-act="again">Start another order</button></div></div></section>`;
  }
  if (o.status === 'cancelled' || o.status === 'expired') {
    return `<section><div class="card"><h3>This order is closed</h3>${head}<div class="acts"><button data-act="again">Start a new order</button></div></div></section>`;
  }
  if (S.hand) {
    const h = S.hand;
    return `<section><div class="card"><h3>Send ${esc(h.amount)} with ${esc(h.name)}</h3>${head}
      <p>Send it to <b>${esc(h.handle)}</b> and put <code class="order">${esc(o.code)}</code> in the note. The shop marks your order paid when it arrives.</p>
      ${said()}<div class="acts">${h.link ? `<button data-go="${esc(h.link)}">Open ${esc(h.name)}</button>` : ''}<button class="secondary" data-act="look">Check again</button><button class="ghost" data-act="ways">Pay another way</button></div></div></section>`;
  }
  if (o.way && o.status === 'pending' && !S.waysFor.length) {
    return `<section><div class="card"><h3>Waiting for your payment</h3>${head}<p>Finish paying on the page that opened. This page changes when the payment arrives.</p>
      ${said()}<div class="acts"><button class="secondary" data-act="look">${S.busy === 'look' ? 'Checking…' : 'Check again'}</button><button class="ghost" data-act="ways">Pay another way</button></div></div></section>`;
  }
  const ways = (S.waysFor.length ? S.waysFor : S.ways).map((w) => `<button class="secondary" data-pay="${esc(w.id)}" ${S.busy ? 'disabled' : ''}><b>${esc(w.name)}</b><span>${w.kind === 'hosted' ? esc((w.carries ?? []).join(' · ')) : 'You send it yourself'}</span></button>`).join('');
  return `<section><div class="card"><h3>How would you like to pay?</h3>${head}<div class="ways">${ways}</div>${said()}<div class="acts"><button class="ghost" data-act="again">Change the order</button></div></div></section>`;
}

function drawOrders() {
  if (!S.orders.length) return '<section><p class="quiet">No orders yet.</p></section>';
  const rows = S.orders.map((o) => {
    const open = o.status === 'awaiting' || o.status === 'pending';
    return `<li class="${open || o.status === 'paid' ? '' : 'off'}"><div class="what"><b>${esc(o.buyer)} <code class="order">${esc(o.id)}</code></b><span>${esc(o.summary)}${o.note ? ` · ${esc(o.note)}` : ''}</span><span class="quiet tnum">${when(o.at)}${o.way ? ` · ${esc(WAY[o.way] ?? o.way)}` : ''}</span></div>
      <span class="price tnum">${money(o.total, o.currency)}</span><span class="mark ${o.status}">${STATUS[o.status] ?? ''}</span>
      ${S.you.editor && open ? `<button class="secondary small" data-paid="${esc(o.id)}">Mark paid</button><button class="ghost small" data-cancel="${esc(o.id)}">Cancel</button>` : ''}</li>`;
  }).join('');
  return `<section><h2>Orders · ${S.orders.length}</h2><ul class="rows">${rows}</ul>${said()}</section>`;
}

function drawMenu() {
  const rows = S.items.map((i) => (S.editing === i.id ? `<li>${editor(S.draft ?? i)}</li>` : `<li class="${i.available ? '' : 'off'}">${thumb(i.image)}<div class="what"><b>${esc(i.name)}</b>${i.description ? `<span>${esc(i.description)}</span>` : ''}</div>
    <span class="price tnum">${money(i.price)}</span><span class="mark">${i.available ? '' : 'Not for sale'}</span><button class="secondary small" data-edit="${esc(i.id)}">Edit</button></li>`)).join('');
  const fresh = S.editing === '' ? `<li>${editor(S.draft ?? { id: '', name: '', description: '', price: 0, min_qty: 1, max_qty: 0, step: 1, available: true, image: '' })}</li>` : '<li><button class="ghost add" data-edit="">+ Add an item</button></li>';
  return `<section><h2>Menu · ${S.items.length}</h2><ul class="rows">${rows}${fresh}</ul></section>`;
}

const editor = (i) => `<div class="edit what" data-item="${esc(i.id)}" data-image="${esc(i.image ?? '')}">
  <div class="field w6"><label>Picture</label>${cell('item', i.image, 'picture')}<small>Optional. It is made small before it is kept.</small></div>
  <div class="field w3"><label for="i-name">Name</label><input id="i-name" maxlength="80" value="${esc(i.name)}"></div>
  <div class="field w3"><label for="i-price">Price</label><input id="i-price" inputmode="decimal" class="tnum" value="${i.price ? (i.price / 10 ** places(S.shop.currency)).toFixed(places(S.shop.currency)) : ''}"></div>
  <div class="field w6"><label for="i-description">Description</label><input id="i-description" maxlength="280" value="${esc(i.description)}"></div>
  <div class="field w2"><label for="i-min">Least in one order</label><input id="i-min" inputmode="numeric" class="tnum" value="${esc(i.min_qty)}"></div>
  <div class="field w2"><label for="i-max">Most in one order</label><input id="i-max" inputmode="numeric" class="tnum" placeholder="No limit" value="${esc(Number(i.max_qty) ? i.max_qty : '')}"></div>
  <div class="field w2"><label for="i-step">Sold in steps of</label><input id="i-step" inputmode="numeric" class="tnum" value="${esc(i.step)}"></div>
  <label class="check w6"><input id="i-available" type="checkbox" ${i.available ? 'checked' : ''}>For sale</label>
  <div class="w6">${said()}<div class="acts"><button data-act="keep">Save</button><button class="secondary" data-act="leave">Cancel</button>${i.id ? '<button class="ghost" data-act="drop">Remove</button>' : ''}</div></div></div>`;

function drawSetup() {
  if (!S.setup) return '<section><p class="quiet">Opening…</p></section>';
  const s = S.setup.shop;
  const hosted = S.setup.hosted.map((p) => `<li><div class="what"><b>${esc(p.name)}</b><span>${esc(p.carries.join(' · '))}</span>${p.ready ? '' : `<span class="quiet">${esc(needs(p))}</span>`}</div><span class="mark ${p.ready ? 'paid' : ''}">${p.ready ? 'Ready' : 'Not set up yet'}</span></li>`).join('');
  const look = S.look ?? { logo: s.logo, color: s.color };
  const dots = Array.from({ length: 12 }, (_, n) => `c${n + 1}`).map((c) => `<button class="dot" data-color="${c}" aria-pressed="${(look.color || 'c4') === c}" aria-label="Color ${c.slice(1)}" style="--dot: var(--os-${c})"></button>`).join('');
  const closed = `<p class="notice">${REACH[S.setup.reach] ?? REACH.none}</p>`;
  return `<section><h2>The shop</h2><div class="edit">
      <div class="field w2"><label>Logo</label>${cell('logo', look.logo, 'logo')}</div>
      <div class="field w4"><label>Color</label><div class="dots">${dots}</div></div>
      <div class="field w3"><label for="s-name">Name</label><input id="s-name" maxlength="80" value="${esc(s.name)}"></div>
      <div class="field w3"><label for="s-currency">Currency</label><input id="s-currency" maxlength="3" value="${esc(s.currency)}"><small>Three letters, like USD or EUR.</small></div>
      <div class="field w6"><label for="s-note">Line under the name</label><input id="s-note" maxlength="200" placeholder="Pick up at the window" value="${esc(s.note)}"></div>
      <label class="check w6"><input id="s-open" type="checkbox" ${s.open ? 'checked' : ''}>Taking orders</label></div></section>
    <section><h2>Paid on the processor's page</h2>${closed}<p class="quiet">The money goes to your own account. Each one needs its key, which you add and allow in this frame's settings, under Keys.</p><ul class="rows">${hosted}</ul>
      <div class="edit"><div class="field w3"><label for="s-square_location">Square location ID</label><input id="s-square_location" maxlength="40" value="${esc(s.square_location)}"></div></div></section>
    <section><h2>Paid by hand</h2><p class="quiet">Buyers send the money themselves with the order code in the note, and you mark the order paid.</p><div class="edit">
      <div class="field w2"><label for="s-venmo">Venmo</label><input id="s-venmo" maxlength="40" placeholder="@name" value="${esc(s.venmo)}"></div>
      <div class="field w2"><label for="s-cashapp">Cash App</label><input id="s-cashapp" maxlength="40" placeholder="$name" value="${esc(s.cashapp)}"></div>
      <div class="field w2"><label for="s-zelle">Zelle</label><input id="s-zelle" maxlength="80" placeholder="Email or phone" value="${esc(s.zelle)}"></div>
      <div class="w6">${said()}<button data-act="shop">${S.busy === 'shop' ? 'Saving…' : 'Save'}</button></div></div></section>`;
}

// The daemon says why a key cannot be spent; the page says what to do about it.
const needs = (p) => (/not set/.test(p.why) ? 'Its key has no value yet.' : /not granted|not allowed/.test(p.why) ? 'Its key is not allowed for this frame yet.' : p.why || 'Its key is missing.');

// ------------------------------------------------------------------- acting

async function load() {
  const v = await api('GET', '/shop');
  Object.assign(S, { shop: v.shop, items: v.items, ways: v.ways, you: v.you });
  if (!S.you.member && S.tab !== 'shop') S.tab = 'shop';
  if (S.you.member) S.orders = (await api('GET', '/orders')).orders;
  if (S.you.editor && S.tab === 'setup') { S.setup = await api('GET', '/setup'); S.look = null; }
}

async function look() {
  const code = S.order?.code ?? new URLSearchParams(location.search).get('order') ?? await prefs.get('order');
  if (!code) return;
  try {
    S.order = (await api('GET', `/order/${encodeURIComponent(code)}`)).order;
    if (S.order.status === 'paid') S.hand = null;
  } catch { S.order = null; await prefs.set('order', ''); }
}

// How publishing this frame shapes paying, said to the people who run the shop.
const REACH = {
  none: 'This shop is not published, so only members can open it, and Stripe, Square and PayPal are not offered: a buyer needs an address to come back to. Publish it in this frame\'s settings, under Sharing.',
  keyed: 'This shop is published by link. A buyer pays in a new tab and goes back to the shop\'s tab, where the order shows as paid within a few seconds. The processor is never given the link, so it cannot send them straight back.',
  open: 'This shop is published to anyone, so a buyer who pays comes straight back to the shop and sees the order paid.',
};

// Where a processor sends the buyer back to: the shop's public link, which
// carries no key. Seated, that is the link the viewer hands out for this
// frame's own address; at that address with no viewer, it is this page.
async function here() {
  if (!SEATED) return location.origin + location.pathname;
  const seat = (window.seamside.space.sessions ?? []).find((t) => t.id === window.seamside.frame.frame)?.seat;
  return seat ? window.seamside.data.publicUrl(seat).catch(() => '') : '';
}

// A seated page cannot leave; the viewer opens the tab. At its own address
// the page is the tab, and goes itself.
function go(url) {
  if (SEATED) window.framelib.frame.openExternalUrl(url);
  else location.assign(url);
}

async function act(name, run) {
  S.error = ''; S.busy = name; draw();
  try { await run(); } catch (e) { S.error = e.message; }
  S.busy = ''; draw();
}

const field = (id) => document.getElementById(id)?.value ?? '';

// What the open editor holds, read from its fields: taken before a picture or
// a colour draws the page again, so nothing typed is lost to it.
function holdItem() {
  const el = document.querySelector('[data-item]');
  if (!el) return null;
  return (S.draft = {
    id: el.dataset.item, name: field('i-name'), description: field('i-description'),
    price: minorOf(field('i-price')), min_qty: field('i-min') || 1, max_qty: field('i-max') || 0, step: field('i-step') || 1,
    available: document.getElementById('i-available').checked, image: el.dataset.image,
  });
}
function holdShop() {
  if (!S.setup || !document.getElementById('s-name')) return;
  for (const k of ['name', 'currency', 'note', 'square_location', 'venmo', 'cashapp', 'zelle']) S.setup.shop[k] = field(`s-${k}`);
  S.setup.shop.open = document.getElementById('s-open').checked;
  S.look ??= { logo: S.setup.shop.logo, color: S.setup.shop.color };
}
const setPic = (what, name) => { if (what === 'logo') { holdShop(); S.look.logo = name; } else { holdItem().image = name; } };

page.addEventListener('change', (e) => {
  const what = e.target.dataset?.file, file = e.target.files?.[0];
  if (!what || !file) return;
  if (what === 'logo') holdShop(); else holdItem();
  act('picture', async () => setPic(what, await keepPicture(what === 'logo' ? 'shop' : 'offerings', file, what === 'logo' ? 400 : 800)));
});

page.addEventListener('input', (e) => {
  if (e.target.id === 'buyer') S.buyer = e.target.value;
  if (e.target.id === 'note') S.note = e.target.value;
});

page.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.tab) return act('', async () => { S.tab = d.tab; S.editing = null; await load(); });
  if (d.more !== undefined || d.less !== undefined) {
    const i = S.items.find((x) => x.id === (d.more ?? d.less));
    const n = S.cart.get(i.id) ?? 0;
    const next = d.more !== undefined ? (n ? n + i.step : i.min_qty) : (n - i.step < i.min_qty ? 0 : n - i.step);
    if (next) S.cart.set(i.id, next); else S.cart.delete(i.id);
    return draw();
  }
  if (d.go) return go(d.go);
  if (d.pick) return page.querySelector(`input[data-file="${d.pick}"]`)?.click();
  if (d.unpic) { setPic(d.unpic, ''); return draw(); }
  if (d.color) { holdShop(); S.look.color = d.color; return draw(); }
  if (d.pay) {
    // A shop that opens only with a key keeps this tab: the processor gets one
    // of its own, opened now, while the click still lets a page open one.
    const way = (S.waysFor.length ? S.waysFor : S.ways).find((w) => w.id === d.pay);
    const tab = !SEATED && way?.tab ? window.open('', '_blank') : null;
    if (tab) tab.opener = null;
    return act('pay', async () => {
      try {
        const v = await api('POST', '/pay', { order: S.order.code, way: d.pay, back: await here() });
        S.order = v.order; S.hand = v.hand ?? null; S.waysFor = [];
        if (v.url && tab) tab.location.replace(v.url);
        else if (v.url) go(v.url);
        else tab?.close();
      } catch (e) { tab?.close(); throw e; }
    });
  }
  if (d.edit !== undefined) { S.editing = d.edit; S.draft = null; S.error = ''; return draw(); }
  if (d.paid || d.cancel) return act('mark', async () => {
    await api('POST', `/order/${encodeURIComponent(d.paid ?? d.cancel)}`, { status: d.paid ? 'paid' : 'cancelled' });
    await load();
  });
  const acts = {
    signin: () => signIn().then(() => act('', load)),
    order: () => act('order', async () => {
      const items = [...S.cart].map(([id, qty]) => ({ id, qty }));
      const v = await api('POST', '/order', { items, name: S.buyer, note: S.note });
      S.order = v.order; S.waysFor = v.ways; S.hand = null;
      await prefs.set('order', v.order.code);
    }),
    look: () => act('look', look),
    ways: () => { S.hand = null; S.waysFor = S.ways; draw(); },
    again: () => { S.order = null; S.hand = null; S.waysFor = []; S.cart.clear(); prefs.set('order', ''); draw(); },
    leave: () => { S.editing = null; S.draft = null; S.error = ''; draw(); },
    // what the fields hold is read before anything is drawn again
    keep: () => {
      const item = {
        id: b.closest('[data-item]').dataset.item, name: field('i-name'), description: field('i-description'),
        price: minorOf(field('i-price')), min_qty: field('i-min') || 1, max_qty: field('i-max') || 0, step: field('i-step') || 1,
        available: document.getElementById('i-available').checked,
        image: b.closest('[data-item]').dataset.image,
      };
      S.draft = item;
      return act('keep', async () => { await api('PUT', '/item', item); S.editing = null; S.draft = null; await load(); });
    },
    drop: () => {
      const id = b.closest('[data-item]').dataset.item;
      return act('drop', async () => { await api('DELETE', `/item/${encodeURIComponent(id)}`); S.editing = null; await load(); });
    },
    shop: () => {
      const put = { open: document.getElementById('s-open').checked };
      for (const k of ['name', 'currency', 'note', 'square_location', 'venmo', 'cashapp', 'zelle']) put[k] = field(`s-${k}`);
      Object.assign(put, S.look ?? {});
      Object.assign(S.setup.shop, put);
      return act('shop', async () => { await api('PUT', '/shop', put); await load(); });
    },
  };
  acts[d.act]?.();
});

// The worker says what changed and never what it holds: re-read, as whoever
// this is. A push is told by framelib as from this page; anything else posting here is not heard.
addEventListener('message', (e) => {
  const m = e.data;
  if (e.source !== window || !m || typeof m !== 'object' || !m.storefront) return;
  if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && S.tab !== 'shop') return;
  (async () => { await load(); if (S.order) await look(); draw(); })().catch(() => {});
});

(async () => {
  await ready;
  try {
    await load();
    await look();
    draw();
    // a payment made on another page arrives here without a push when this
    // page is its own tab: ask while an order waits
    const ask = async () => {
      if (!S.order || S.order.status === 'paid' || document.hidden || S.busy) return;
      const was = S.order.status;
      await look();
      if (S.order?.status !== was) draw();
    };
    setInterval(ask, 5000);
    // the buyer coming back from the processor's page is the moment to ask
    document.addEventListener('visibilitychange', ask);
  } catch (e) {
    page.innerHTML = `<p class="err" role="alert">${esc(e.message)}</p>`;
  }
})();
