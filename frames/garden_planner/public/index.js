import { frame } from "./lib/js/framelib.js";

const urlSfi = new URLSearchParams(location.search).get('sfi') || '';
const withSfi = (url) => urlSfi ? url + (url.includes('?') ? '&' : '?') + 'sfi=' + encodeURIComponent(urlSfi) : url;
const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ----- Color mapping ---------------------------------------------------------------
// 3 anchor colors: vibrant green (low) → soft yellow (mid) → red (high). Each plot's
// {low, avg, high} stress map to these and form a radial gradient with high at center
// and low at the outer edge.
const COLOR_LOW = '#4ade80';   // vibrant green
const COLOR_MID = '#facc15';   // soft yellow
const COLOR_HIGH = '#ef4444';  // red

function stressColor(value) {
  if (!Number.isFinite(value)) return COLOR_MID;
  if (value < 33) return COLOR_LOW;
  if (value < 66) return COLOR_MID;
  return COLOR_HIGH;
}

function plotBackground(stress) {
  if (!stress) return '';
  const cHigh = stressColor(stress.high);
  const cMid = stressColor(stress.avg);
  const cLow = stressColor(stress.low);
  return `radial-gradient(circle at center, ${cHigh} 0%, ${cMid} 50%, ${cLow} 100%)`;
}

// ----- State -----------------------------------------------------------------------
let state = {
  prefs: { org_name: 'Garden Plotter', location: '', grid_cols: 24, grid_rows: 16, grid_px: 32, owner_only_edit: false, allow_public_viewing: false },
  viewer: { user_name: 'anon', is_owner: false, is_anon: true },
  can_edit: false,
  plant_types: [],
  stages: [],
  weather: null,
};
let plots = [];
let memberRoster = [];
let publicDisabled = false;
let mode = 'view'; // 'view' | 'edit'
let editingPlotId = null;

const canvasEl = document.getElementById('canvas');
const emptyEl = document.getElementById('empty');

// ----- Fetching ---------------------------------------------------------------------
// The /api/plots route returns 503 ("tables not yet bound") which we surface as a
// {__waiting: true} sentinel, so we keep the raw-Response wrapper (frame.fetch)
// instead of frame.api (which throws on non-2xx).
async function fetchJSON(url, opts) {
  const r = await frame.fetch(withSfi(url), opts);
  if (r.status === 503) return { __waiting: true };
  if (r.status === 204) return null;
  try { return await r.json(); } catch { return null; }
}

// Writes go over the tether (frame.busSend), not HTTP: Android's webview drops HTTP
// request bodies, so a POST silently becomes an empty write there (see #750 /
// docs/tether-writes.md). Fire-and-forget — the canvas redraws from the matching push,
// sender included, and a refused write is logged by the backend rather than answered.
// Feature-detect: an older viewer's framelib has no busSend, so fall back to the POST
// this frame used before.
function write(op, payload) {
  if (typeof frame.busSend === 'function') {
    frame.busSend({ op, ...(payload || {}) });
    return Promise.resolve({});
  }
  return fetchJSON('./api/' + op, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

async function loadState() {
  const s = await fetchJSON('./api/state');
  if (!s || s.__waiting) return false;
  state = s;
  document.getElementById('org-name').textContent = state.prefs.org_name || 'Garden Plotter';
  document.title = state.prefs.org_name || 'Garden Plotter';

  // Header rail: one word, three outcomes.
  document.getElementById('role-label').textContent =
    state.viewer.is_owner ? 'owner' : state.can_edit ? 'editor' : 'viewer';
  const stor = state.storage;
  const dataBtn = document.getElementById('data-btn');
  dataBtn.classList.toggle('hidden', !(stor && stor.can_manage));
  // A unit still mid-flow is the only ambient signal the drawer ever shows.
  const anyPending = !!(stor && stor.units.some((u) => u.pending));
  dataBtn.title = anyPending ? 'Finishing a change to the garden data' : 'Garden data';

  // Header actions visibility.
  document.getElementById('settings-btn').classList.toggle('hidden', !state.viewer.is_owner);
  document.getElementById('mode-btn').classList.toggle('hidden', !state.can_edit);
  document.getElementById('add-btn').classList.toggle('hidden', !(state.can_edit && mode === 'edit'));
  const showRoNote = !state.can_edit && state.prefs.owner_only_edit && !state.viewer.is_anon;
  document.getElementById('readonly-note').classList.toggle('hidden', !showRoNote);
  const showSetup = state.viewer.is_owner && !state.prefs.location;
  document.getElementById('setup-note').classList.toggle('hidden', !showSetup);

  // Weather chip.
  const chip = document.getElementById('weather-chip');
  if (state.weather) {
    chip.classList.remove('hidden');
    document.getElementById('weather-text').textContent =
      `${state.weather.resolved_name} · ${Math.round(state.weather.avg_temp)}°F avg · ${state.weather.total_rain_in.toFixed(1)}" rain · UV ${state.weather.max_uv.toFixed(0)}`;
  } else {
    chip.classList.add('hidden');
  }

  applyCanvasSize();
  return true;
}

function applyCanvasSize() {
  const px = state.prefs.grid_px;
  canvasEl.style.width = (state.prefs.grid_cols * px) + 'px';
  canvasEl.style.height = (state.prefs.grid_rows * px) + 'px';
  canvasEl.style.backgroundSize = `${px}px ${px}px, ${px}px ${px}px`;
  canvasEl.classList.toggle('is-edit', mode === 'edit' && state.can_edit);
}

async function loadMembers() {
  if (state.viewer.is_anon) { memberRoster = []; return; }
  const r = await fetchJSON('./api/members');
  memberRoster = (r && r.rows) || [];
}

async function loadPlots() {
  const r = await fetchJSON('./api/plots');
  if (!r || r.__waiting) {
    canvasEl.querySelectorAll('.plot').forEach((el) => el.remove());
    emptyEl.classList.remove('hidden');
    document.getElementById('empty-text').textContent = 'Waiting for setup…';
    return;
  }
  publicDisabled = !!r.public_disabled;
  plots = r.rows || [];
  document.getElementById('count-badge').textContent = publicDisabled ? '—' : String(plots.length);
  renderPlots();
}

// ----- Rendering --------------------------------------------------------------------
function renderPlots() {
  const px = state.prefs.grid_px;
  // Remove existing plot DOM.
  canvasEl.querySelectorAll('.plot').forEach((el) => el.remove());

  if (publicDisabled) {
    emptyEl.classList.remove('hidden');
    document.getElementById('empty-text').textContent = 'Public view of the garden is disabled.';
    return;
  }
  if (plots.length === 0) {
    emptyEl.classList.remove('hidden');
    document.getElementById('empty-text').textContent =
      state.can_edit ? 'No plots yet. Switch to edit mode and add one.' : 'No plots yet.';
    return;
  }
  emptyEl.classList.add('hidden');

  for (const p of plots) {
    const el = document.createElement('div');
    el.className = 'plot' + (mode === 'edit' && state.can_edit ? ' is-edit' : '');
    el.dataset.row = p._row_id;
    el.style.left = (p.pos_x * px) + 'px';
    el.style.top = (p.pos_y * px) + 'px';
    el.style.width = (p.width * px) + 'px';
    el.style.height = (p.height * px) + 'px';
    if (p.stress_known && p.stress) {
      el.style.background = plotBackground(p.stress);
    }
    const plantsHtml = (p.per_plant || [])
      .slice(0, 6)
      .map((pp) => {
        const meta = state.plant_types.find((t) => t.key === pp.plant);
        const iconCls = meta ? `ph-light ${escapeHTML(meta.icon)}` : 'ph-light ph-plant';
        const known = pp.stress_known;
        const pct = known ? Math.max(0, Math.min(100, pp.stress)) : 0;
        const title = `${escapeHTML(pp.label)}${known ? ` · ${Math.round(pp.stress)}/100` : ''}`;
        return `
          <div class="plot-plant" title="${title}">
            <i class="${iconCls}"></i>
            <div class="plot-bar ${known ? '' : 'is-unknown'}" style="--stress: ${pct}%"></div>
          </div>`;
      })
      .join('');
    const assigned = p.assigned_label ? escapeHTML(p.assigned_label) : '';
    const sunIcon = p.shade_pct === 0 ? 'ph-cloud' : p.shade_pct === 50 ? 'ph-cloud-sun' : 'ph-sun';
    const nameStr = (p.name || '').trim();
    el.innerHTML = `
      <div class="plot-sun" title="${escapeHTML(shadeLabel(p.shade_pct))}"><i class="ph-light ${sunIcon}"></i></div>
      <div class="plot-label">
        ${nameStr ? `<div class="plot-name">${escapeHTML(nameStr)}</div>` : ''}
        ${assigned ? `<div class="plot-meta">${assigned}</div>` : ''}
        ${plantsHtml ? `<div class="plot-plants">${plantsHtml}</div>` : ''}
      </div>
      <div class="plot-grip"></div>
    `;
    canvasEl.appendChild(el);
  }
}

// ----- Drag / resize / click on plots ----------------------------------------------
// Two drag flavors:
//   - Plot drag: pointerdown on an existing .plot in edit mode → move or resize it.
//   - Add drag: pointerdown on empty canvas in edit mode → marquee a new plot rectangle.
// `justMovedAt` is set in pointerup so the synthesized click event right after a drag
// can be suppressed (drag itself is nulled before the click fires, hence the timestamp).
let drag = null;
let addDrag = null;
let addGhostEl = null;
let justMovedAt = 0;

function gridXYAtPointer(e) {
  const px = state.prefs.grid_px;
  const rect = canvasEl.getBoundingClientRect();
  const x = (e.clientX - rect.left) / px;
  const y = (e.clientY - rect.top) / px;
  return { x: Math.max(0, Math.min(state.prefs.grid_cols, x)), y: Math.max(0, Math.min(state.prefs.grid_rows, y)) };
}

canvasEl.addEventListener('pointerdown', (e) => {
  if (mode !== 'edit' || !state.can_edit) {
    // View mode: let click handler open detail; nothing to set up here.
    return;
  }
  const plotEl = e.target.closest('.plot');
  if (plotEl) {
    const rowId = plotEl.dataset.row;
    const p = plots.find((x) => x._row_id === rowId);
    if (!p) return;
    const grip = e.target.closest('.plot-grip');
    drag = {
      rowId,
      mode: grip ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      origPlot: { pos_x: p.pos_x, pos_y: p.pos_y, width: p.width, height: p.height },
      el: plotEl,
      moved: false,
    };
    plotEl.setPointerCapture(e.pointerId);
    plotEl.classList.add('is-selected');
    e.preventDefault();
    return;
  }
  // Empty canvas → start a marquee for a new plot.
  if (e.target !== canvasEl && !e.target.classList?.contains('empty')) return;
  const start = gridXYAtPointer(e);
  addDrag = {
    startX: e.clientX,
    startY: e.clientY,
    startCellX: Math.floor(start.x),
    startCellY: Math.floor(start.y),
    cur: { x: Math.floor(start.x), y: Math.floor(start.y), w: 1, h: 1 },
    moved: false,
  };
  addGhostEl = document.createElement('div');
  addGhostEl.className = 'plot is-ghost';
  positionGhost();
  canvasEl.appendChild(addGhostEl);
  canvasEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});

function positionGhost() {
  if (!addGhostEl || !addDrag) return;
  const px = state.prefs.grid_px;
  addGhostEl.style.left = (addDrag.cur.x * px) + 'px';
  addGhostEl.style.top = (addDrag.cur.y * px) + 'px';
  addGhostEl.style.width = (addDrag.cur.w * px) + 'px';
  addGhostEl.style.height = (addDrag.cur.h * px) + 'px';
}

canvasEl.addEventListener('pointermove', (e) => {
  if (drag) {
    const px = state.prefs.grid_px;
    const dx = Math.round((e.clientX - drag.startX) / px);
    const dy = Math.round((e.clientY - drag.startY) / px);
    if (Math.abs(e.clientX - drag.startX) > 4 || Math.abs(e.clientY - drag.startY) > 4) drag.moved = true;
    if (drag.mode === 'move') {
      const newX = Math.max(0, Math.min(state.prefs.grid_cols - drag.origPlot.width, drag.origPlot.pos_x + dx));
      const newY = Math.max(0, Math.min(state.prefs.grid_rows - drag.origPlot.height, drag.origPlot.pos_y + dy));
      drag.el.style.left = (newX * px) + 'px';
      drag.el.style.top = (newY * px) + 'px';
      drag.next = { pos_x: newX, pos_y: newY, width: drag.origPlot.width, height: drag.origPlot.height };
    } else {
      const newW = Math.max(1, Math.min(state.prefs.grid_cols - drag.origPlot.pos_x, drag.origPlot.width + dx));
      const newH = Math.max(1, Math.min(state.prefs.grid_rows - drag.origPlot.pos_y, drag.origPlot.height + dy));
      drag.el.style.width = (newW * px) + 'px';
      drag.el.style.height = (newH * px) + 'px';
      drag.next = { pos_x: drag.origPlot.pos_x, pos_y: drag.origPlot.pos_y, width: newW, height: newH };
    }
    return;
  }
  if (addDrag) {
    if (Math.abs(e.clientX - addDrag.startX) > 2 || Math.abs(e.clientY - addDrag.startY) > 2) addDrag.moved = true;
    const cur = gridXYAtPointer(e);
    const x0 = addDrag.startCellX;
    const y0 = addDrag.startCellY;
    const x1 = Math.floor(cur.x);
    const y1 = Math.floor(cur.y);
    const minX = Math.max(0, Math.min(x0, x1));
    const minY = Math.max(0, Math.min(y0, y1));
    const maxX = Math.min(state.prefs.grid_cols - 1, Math.max(x0, x1));
    const maxY = Math.min(state.prefs.grid_rows - 1, Math.max(y0, y1));
    addDrag.cur = { x: minX, y: minY, w: (maxX - minX) + 1, h: (maxY - minY) + 1 };
    positionGhost();
  }
});

canvasEl.addEventListener('pointerup', async (e) => {
  if (drag) {
    const finished = drag;
    drag = null;
    finished.el.classList.remove('is-selected');
    if (finished.moved) justMovedAt = Date.now();
    if (finished.moved && finished.next) {
      const p = plots.find((x) => x._row_id === finished.rowId);
      if (p) Object.assign(p, finished.next);
      await write('plot/move', { row_id: finished.rowId, ...finished.next });
    }
    return;
  }
  if (addDrag) {
    const final = addDrag;
    addDrag = null;
    if (addGhostEl) { addGhostEl.remove(); addGhostEl = null; }
    if (final.moved) justMovedAt = Date.now();
    // Discard zero-area drags or anything sub-1x1 (shouldn't happen with floor/ceil math
    // but be defensive). The user explicitly asked: ignore if smaller than a single cell.
    if (final.cur.w < 1 || final.cur.h < 1) return;
    // Block creation if it overlaps an existing plot.
    const collides = plots.some((p) =>
      final.cur.x < p.pos_x + p.width && final.cur.x + final.cur.w > p.pos_x &&
      final.cur.y < p.pos_y + p.height && final.cur.y + final.cur.h > p.pos_y);
    if (collides) return;
    openEditDialog({
      _row_id: null,
      name: '',
      pos_x: final.cur.x, pos_y: final.cur.y,
      width: final.cur.w, height: final.cur.h,
      assigned_member_id: '', assigned_manual_name: '',
      per_plant: [], shade_pct: 100, notes: '',
    });
  }
});

canvasEl.addEventListener('click', (e) => {
  const plotEl = e.target.closest('.plot');
  if (!plotEl) return;
  // Suppress the click that fires immediately after a drag-move/resize.
  if (Date.now() - justMovedAt < 250) return;
  const rowId = plotEl.dataset.row;
  const p = plots.find((x) => x._row_id === rowId);
  if (!p) return;
  if (mode === 'edit' && state.can_edit) openEditDialog(p);
  else openDetailDialog(p);
});

// ----- Mode toggle ------------------------------------------------------------------
document.getElementById('mode-btn').addEventListener('click', () => {
  mode = mode === 'edit' ? 'view' : 'edit';
  document.getElementById('mode-label').textContent = mode === 'edit' ? 'done' : 'edit';
  document.getElementById('add-btn').classList.toggle('hidden', !(state.can_edit && mode === 'edit'));
  applyCanvasSize();
  renderPlots();
});

// ----- Add plot ---------------------------------------------------------------------
document.getElementById('add-btn').addEventListener('click', () => {
  // Find a free spot for a 3x2 plot (or smaller if grid is tiny).
  const w = Math.min(3, state.prefs.grid_cols);
  const h = Math.min(2, state.prefs.grid_rows);
  let placed = null;
  outer: for (let y = 0; y <= state.prefs.grid_rows - h; y++) {
    for (let x = 0; x <= state.prefs.grid_cols - w; x++) {
      const collides = plots.some((p) =>
        x < p.pos_x + p.width && x + w > p.pos_x &&
        y < p.pos_y + p.height && y + h > p.pos_y);
      if (!collides) { placed = { x, y }; break outer; }
    }
  }
  if (!placed) placed = { x: 0, y: 0 };
  openEditDialog({
    _row_id: null,
    name: '',
    pos_x: placed.x, pos_y: placed.y, width: w, height: h,
    assigned_member_id: '', assigned_manual_name: '',
    per_plant: [],
    notes: '',
  });
});

document.getElementById('setup-open-settings').addEventListener('click', () => openSettings());

// ----- Detail dialog ----------------------------------------------------------------
const detailOverlay = document.getElementById('detail-overlay');
const detailBody = document.getElementById('detail-body');
const detailEditBtn = document.getElementById('detail-edit');
let detailRowId = null;

function fmtDate(ms) {
  const n = Number(ms);
  if (!n) return '';
  return new Date(n).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function stageLabel(stage) {
  const s = state.stages.find((x) => x.key === stage);
  return s ? s.label : stage || '';
}

function openDetailDialog(p) {
  detailRowId = p._row_id;
  document.getElementById('detail-title').textContent = p.name || 'Plot';
  detailEditBtn.classList.toggle('hidden', !state.can_edit);

  const rows = [];
  const ownerText = p.assigned_label
    ? p.assigned_label
    : 'Community plot (unclaimed)';
  if (state.viewer.is_anon) {
    rows.push(detailRow('Plants', (p.per_plant || []).map((pp) => escapeHTML(pp.label)).join(', ') || '—'));
    rows.push(detailRow('Sun', escapeHTML(shadeLabel(p.shade_pct))));
  } else {
    rows.push(detailRow('Owned by', escapeHTML(ownerText)));
    rows.push(detailRow('Size', `${p.width} × ${p.height} cells at (${p.pos_x}, ${p.pos_y})`));
    rows.push(detailRow('Sun', escapeHTML(shadeLabel(p.shade_pct))));
    if (p.notes) rows.push(detailRow('Notes', escapeHTML(p.notes)));
    if ((!p.per_plant || p.per_plant.length === 0)) {
      rows.push(detailRow('Plants', '—'));
    }
  }

  // Per-plant stress
  let stressBlock = '';
  if (p.per_plant && p.per_plant.length > 0) {
    if (p.stress_known) {
      stressBlock = `<div class="detail-stress-list">
        <div class="label" style="font-size: var(--os-fs-2xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--os-text-muted);">stress per plant</div>
        ${p.per_plant.map(renderStressRow).join('')}
      </div>`;
    } else {
      stressBlock = `<div class="detail-stress-list">
        <div class="label" style="font-size: var(--os-fs-2xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--os-text-muted);">stress unavailable</div>
        <div style="font-size: var(--os-fs-xs); color: var(--os-text-muted);">${state.prefs.location ? 'Add a planting date and stage to compute stress.' : 'Set a location in settings to compute stress.'}</div>
      </div>`;
    }
  }

  detailBody.innerHTML = rows.join('') + stressBlock;
  detailOverlay.classList.remove('hidden');
}

function detailRow(label, val) {
  return `<div class="detail-row"><span class="label">${escapeHTML(label)}</span><span class="val">${val}</span></div>`;
}

function renderStressRow(pp) {
  const meta = state.plant_types.find((t) => t.key === pp.plant);
  const color = pp.stress_known ? stressColor(pp.stress) : 'var(--os-text-subtle)';
  const pct = pp.stress_known ? Math.max(2, Math.min(100, pp.stress)) : 0;
  const num = pp.stress_known ? `${Math.round(pp.stress)}/100` : '—';
  const stageBit = pp.planted_at && pp.planted_stage
    ? `<div class="num" style="font-size: var(--os-fs-2xs); margin-top: 2px;">planted ${escapeHTML(fmtDate(pp.planted_at))} as ${escapeHTML(stageLabel(pp.planted_stage))} · now ${escapeHTML(stageLabel(pp.current_stage))}</div>`
    : '<div class="num" style="font-size: var(--os-fs-2xs); margin-top: 2px;">no planting date</div>';
  return `
    <div class="detail-stress-row">
      <span class="name">
        <span style="display: flex; flex-direction: column; gap: 2px;">
          <span style="display: flex; align-items: center; gap: var(--os-sp-xs);">${meta ? `<i class="ph-light ${escapeHTML(meta.icon)}"></i>` : ''}${escapeHTML(pp.label)}</span>
          ${stageBit}
        </span>
      </span>
      <span class="num">${num}</span>
      <span class="bar"><span class="fill" style="width: ${pct}%; background: ${color};"></span></span>
    </div>`;
}

document.getElementById('detail-close').addEventListener('click', () => detailOverlay.classList.add('hidden'));
document.getElementById('detail-cancel').addEventListener('click', () => detailOverlay.classList.add('hidden'));
detailOverlay.addEventListener('click', (e) => { if (e.target === detailOverlay) detailOverlay.classList.add('hidden'); });
detailEditBtn.addEventListener('click', () => {
  detailOverlay.classList.add('hidden');
  const p = plots.find((x) => x._row_id === detailRowId);
  if (p) openEditDialog(p);
});

// ----- Edit dialog ------------------------------------------------------------------
const editOverlay = document.getElementById('edit-overlay');
const editName = document.getElementById('edit-name');
const editWidth = document.getElementById('edit-width');
const editHeight = document.getElementById('edit-height');
const editMember = document.getElementById('edit-member');
const editManual = document.getElementById('edit-manual');
const editNotes = document.getElementById('edit-notes');
const editPlants = document.getElementById('edit-plants');
const editDelete = document.getElementById('edit-delete');
const assignMemberField = document.getElementById('assign-member-field');
const assignManualField = document.getElementById('assign-manual-field');
let assignMode = 'member';
let editPos = { x: 0, y: 0 };

function setAssignMode(m) {
  assignMode = m;
  document.querySelectorAll('#assign-mode .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === m);
  });
  assignMemberField.classList.toggle('hidden', m !== 'member');
  assignManualField.classList.toggle('hidden', m !== 'manual');
}

document.querySelectorAll('#assign-mode .seg-btn').forEach((b) => {
  b.addEventListener('click', () => setAssignMode(b.dataset.mode));
});

let shadePct = 100;
function setShade(p) {
  shadePct = (p === 0 || p === 50 || p === 100) ? p : 100;
  document.querySelectorAll('#shade-mode .seg-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.shade) === shadePct);
  });
}
document.querySelectorAll('#shade-mode .seg-btn').forEach((b) => {
  b.addEventListener('click', () => setShade(Number(b.dataset.shade)));
});

function shadeLabel(p) {
  if (p === 0) return 'full shade';
  if (p === 50) return 'part shade';
  return 'full sun';
}

function populateMemberSelect(currentId) {
  editMember.innerHTML = memberRoster.length === 0
    ? '<option value="">(no members in roster)</option>'
    : memberRoster.map((m) =>
        `<option value="${escapeHTML(m._row_id)}"${m._row_id === currentId ? ' selected' : ''}>${escapeHTML(m.name)}${m.role ? ' · ' + escapeHTML(m.role) : ''}</option>`).join('');
}

// Build per-plant rows. Each row has a checkbox + (when checked) a date input and a
// stage select. Existing entries are pre-populated; unchecked rows are excluded on save.
function populatePlantRows(existing) {
  const byKey = new Map((existing || []).map((e) => [e.plant, e]));
  editPlants.innerHTML = state.plant_types.map((t) => {
    const cur = byKey.get(t.key);
    const on = !!cur;
    const dateVal = cur && cur.planted_at ? new Date(cur.planted_at).toISOString().slice(0, 10) : '';
    const stageOpts = '<option value="">stage…</option>' + state.stages.map((s) =>
      `<option value="${escapeHTML(s.key)}"${cur && cur.planted_stage === s.key ? ' selected' : ''}>${escapeHTML(s.label)}</option>`).join('');
    return `
      <div class="plant-row ${on ? 'is-on' : 'is-off'}" data-plant="${escapeHTML(t.key)}">
        <label class="plant-check">
          <input type="checkbox" ${on ? 'checked' : ''}>
          <i class="ph-light ${escapeHTML(t.icon)}"></i>
          <span>${escapeHTML(t.label)}</span>
        </label>
        <div class="plant-when">
          <input type="date" class="plant-date" value="${escapeHTML(dateVal)}">
          <select class="plant-stage">${stageOpts}</select>
        </div>
      </div>`;
  }).join('');
  editPlants.querySelectorAll('.plant-row').forEach((row) => {
    const cb = row.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      row.classList.toggle('is-on', cb.checked);
      row.classList.toggle('is-off', !cb.checked);
    });
  });
}

function readPlantRows() {
  const out = [];
  editPlants.querySelectorAll('.plant-row').forEach((row) => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (!cb.checked) return;
    const plant = row.dataset.plant;
    const dateVal = row.querySelector('.plant-date').value;
    const stageVal = row.querySelector('.plant-stage').value;
    out.push({
      plant_type: plant,
      planted_at: dateVal ? new Date(dateVal + 'T00:00:00').getTime() : null,
      planted_stage: stageVal || null,
    });
  });
  return out;
}

function openEditDialog(p) {
  editingPlotId = p._row_id;
  document.getElementById('edit-title').textContent = p._row_id ? 'Edit plot' : 'New plot';
  editName.value = p.name || '';
  editWidth.value = String(p.width || 3);
  editHeight.value = String(p.height || 2);
  editPos = { x: p.pos_x ?? 0, y: p.pos_y ?? 0 };
  editManual.value = p.assigned_manual_name || '';
  populateMemberSelect(p.assigned_member_id || '');
  populatePlantRows(p.per_plant || []);
  editNotes.value = p.notes || '';
  setShade(p.shade_pct === 0 || p.shade_pct === 50 || p.shade_pct === 100 ? p.shade_pct : 100);
  if (p.assigned_member_id) setAssignMode('member');
  else if (p.assigned_manual_name) setAssignMode('manual');
  else setAssignMode(memberRoster.length > 0 ? 'member' : 'none');
  editDelete.classList.toggle('hidden', !p._row_id);
  editOverlay.classList.remove('hidden');
}

document.getElementById('edit-close').addEventListener('click', () => editOverlay.classList.add('hidden'));
document.getElementById('edit-cancel').addEventListener('click', () => editOverlay.classList.add('hidden'));
editOverlay.addEventListener('click', (e) => { if (e.target === editOverlay) editOverlay.classList.add('hidden'); });

document.getElementById('edit-save').addEventListener('click', async () => {
  const name = editName.value.trim();
  const width = Math.max(1, Math.min(state.prefs.grid_cols, Number(editWidth.value) || 1));
  const height = Math.max(1, Math.min(state.prefs.grid_rows, Number(editHeight.value) || 1));
  const payload = {
    row_id: editingPlotId,
    name,
    pos_x: editPos.x,
    pos_y: editPos.y,
    width, height,
    shade_pct: shadePct,
    assigned_member_id: assignMode === 'member' ? editMember.value : '',
    assigned_manual_name: assignMode === 'manual' ? editManual.value : '',
    plants: readPlantRows(),
    notes: editNotes.value,
  };
  await write('plot', payload);
  editOverlay.classList.add('hidden');
});

editDelete.addEventListener('click', async () => {
  if (!editingPlotId) return;
  const p = plots.find((x) => x._row_id === editingPlotId);
  if (!(await frame.confirm(`Delete "${p ? p.name : 'this plot'}"?`, { danger: true }))) return;
  await write('plot/delete', { row_id: editingPlotId });
  editOverlay.classList.add('hidden');
});

// ----- Settings dialog --------------------------------------------------------------
const settingsOverlay = document.getElementById('settings-overlay');
const cfgOrg = document.getElementById('cfg-org');
const cfgLocation = document.getElementById('cfg-location');
const cfgCols = document.getElementById('cfg-cols');
const cfgRows = document.getElementById('cfg-rows');
const cfgPx = document.getElementById('cfg-px');
const cfgOwnerOnly = document.getElementById('cfg-owner-only');
const cfgAllowPublic = document.getElementById('cfg-allow-public');

function openSettings() {
  cfgOrg.value = state.prefs.org_name || '';
  cfgLocation.value = state.prefs.location || '';
  cfgCols.value = String(state.prefs.grid_cols);
  cfgRows.value = String(state.prefs.grid_rows);
  cfgPx.value = String(state.prefs.grid_px);
  cfgOwnerOnly.checked = !!state.prefs.owner_only_edit;
  cfgAllowPublic.checked = !!state.prefs.allow_public_viewing;
  settingsOverlay.classList.remove('hidden');
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
document.getElementById('settings-cancel').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden'); });

document.getElementById('settings-save').addEventListener('click', async () => {
  const payload = {
    org_name: cfgOrg.value.trim(),
    location: cfgLocation.value.trim(),
    grid_cols: Number(cfgCols.value) || 24,
    grid_rows: Number(cfgRows.value) || 16,
    grid_px: Number(cfgPx.value) || 32,
    owner_only_edit: cfgOwnerOnly.checked,
    allow_public_viewing: cfgAllowPublic.checked,
  };
  await write('settings', payload);
  settingsOverlay.classList.add('hidden');   // the settings_changed push reloads everything
});

// ----- The data drawer (owner-only) --------------------------------------------------
// ONE button, ONE surface. The frame says nothing about storage at rest; every data
// action for every unit lives behind here, listing each unit with its state as the
// detail line. Single call site so #755 (frame-chrome data controls) can replace it
// wholesale. See docs/table-graduation.md.
const UNIT_STATE_TEXT = {
  local:  'on this device',
  shared: 'in a shared table',
  none:   'not linked',
};

document.getElementById('data-btn').addEventListener('click', async () => {
  const stor = state.storage;
  if (!stor || !stor.can_manage) return;

  const pending = stor.units.find((u) => u.pending);
  if (pending) {
    const stop = await frame.confirm(`Stop the change to ${pending.label.toLowerCase()}?`, {
      title: 'Garden data', okLabel: 'Stop', cancelLabel: 'Keep going',
    });
    if (stop) await write('data/cancel_graduate', { unit: pending.unit });
    return;
  }

  const unit = stor.units.length === 1 ? stor.units[0].unit : await frame.choose('Which data?', {
    title: 'Garden data',
    options: stor.units.map((u) => ({
      id: u.unit, label: u.label,
      icon: u.unit === 'members' ? 'ph-users' : 'ph-dresser',
      detail: UNIT_STATE_TEXT[u.backend] || u.backend,
    })),
  });
  if (!unit) return;
  const u = stor.units.find((x) => x.unit === unit);
  if (!u) return;

  // The roster is a link unit — adopt-only, and unlinking loses nothing because it owns
  // no data. The plots unit is ours, so it offers the full convert-or-adopt choice.
  if (u.kind === 'link') {
    if (u.backend === 'shared') {
      const off = await frame.confirm(
        'Unlink the member roster? Plots keep the names already on them, and you can type names in by hand.',
        { title: u.label, okLabel: 'Unlink' });
      if (off) await write('data/unlink', { unit });
      return;
    }
    const on = await frame.confirm(
      'Link a shared member roster? Pick the table your members live in — the schema matches Member Manager.',
      { title: u.label, okLabel: 'Link' });
    if (on) await write('data/graduate', { unit, mode: 'adopt' });
    return;
  }

  if (u.backend === 'shared') {
    await frame.alert('These plots live in a shared table, so other frames in this space can work with the same rows.',
      { title: u.label });
    return;
  }
  const mode = await frame.choose('These plots live on this device.', {
    title: u.label,
    options: [
      { id: 'convert', label: 'Move to a shared table', icon: 'ph-dresser',
        detail: 'Copies this garden so other frames can use it' },
      { id: 'adopt', label: 'Use an existing shared table', icon: 'ph-plugs-connected',
        detail: 'Point this garden at a table you already have' },
    ],
  });
  if (mode) await write('data/graduate', { unit, mode });
});

// ----- Live updates -----------------------------------------------------------------
window.addEventListener('message', async (e) => {
  if (e.data?.type === 'plots_changed') loadPlots();
  else if (e.data?.type === 'members_changed') { await loadMembers(); }
  else if (e.data?.type === 'settings_changed') { await loadState(); await loadMembers(); await loadPlots(); }
});

// Periodic refresh — weather summary updates and stress can shift over the day.
setInterval(() => { if (!document.hidden) { loadState().then(() => loadPlots()); } }, 5 * 60 * 1000);

// ----- Boot -------------------------------------------------------------------------
(async () => {
  const ok = await loadState();
  if (!ok) {
    emptyEl.classList.remove('hidden');
    document.getElementById('empty-text').textContent = 'Waiting for the space owner to bind SyncTables for the garden…';
    return;
  }
  await loadMembers();
  await loadPlots();
  // First-time setup: if the owner just placed this frame and hasn't picked a location
  // yet, drop them straight into settings. Stress can't be computed without weather, so
  // the location is the one piece of config that actually blocks the frame from being
  // useful — the rest has sensible defaults.
  if (state.viewer.is_owner && !state.prefs.location) {
    openSettings();
  }
})();
