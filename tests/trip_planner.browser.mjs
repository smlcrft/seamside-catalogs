// Trip Planner in the viewer: the keeper plans a trip by clicks and typing, the map pins
// what has a place, and a stranger at the published address follows it live, read-only.
// Run offline (HTTPS_PROXY to a closed port), the map's route answers that it cannot reach
// OpenFreeMap; run online, its attribution arrives through the worker.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const offline = !!process.env.HTTPS_PROXY;
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '').trim()`;
  const acts = `[...document.querySelectorAll('.it-row .it-act')].map((e) => e.textContent).join('|')`;
  const setDate = (b, sel, v) => b.inFrame(`const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const at = (b, sel) => b.inFrame(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top };`);
  const drag = async (b, from, to) => {
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', buttons, clickCount: 1 }, b.child);
    const carry = (type, p) => b.send('Input.dispatchDragEvent', { type, x: Math.round(p.x), y: Math.round(p.y), data: { items: [], dragOperationsMask: 16 } }, b.child);
    await b.send('Input.setInterceptDrags', { enabled: true }, b.child);
    await mouse('mouseMoved', from, 0);
    await mouse('mousePressed', from, 1);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', { x: from.x + 2 * i, y: from.y + 2 * i }, 1);
    await carry('dragEnter', to);
    for (let i = 0; i < 3; i++) { await carry('dragOver', to); await sleep(50); }
    await carry('drop', to);
    await mouse('mouseReleased', to, 0);
    await b.send('Input.setInterceptDrags', { enabled: false }, b.child);
    await sleep(500);
  };
  const reload = async (b) => {
    await b.send('Page.reload');
    b.child = null;
    for (let i = 0; i < 60 && !b.child; i++) await sleep(250);
  };

  // ----- the first trip, from the empty state
  if (!await keeper.until('the first-trip form', `!!document.querySelector('#tf-name')`)) return;
  expect(await keeper.inFrame(`return /Plan your first trip/.test(document.body.textContent) && ${text('.header .mode')} === 'owner' && !document.querySelector('.banner')`), 'the keeper is the owner, offered a first trip');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.tform')).display === 'flex' && document.styleSheets.length >= 2`), 'the page has its style');
  expect(await keeper.inFrame(`return document.querySelector('.tform .btn-primary').disabled`), 'Create trip waits for a name');
  await keeper.shot('1-first-trip');
  await keeper.fill('#tf-name', 'Big Sur');
  await keeper.fill('#tf-dest', 'Big Sur');
  await setDate(keeper, '#tf-start', '2026-08-10');
  await setDate(keeper, '#tf-end', '2026-08-11');
  await keeper.click('.tform .btn-primary');
  const trip = await untilRows('the trip', 'trips', (r) => r.find((x) => x.cells.name === 'Big Sur'));
  expect(trip?.cells.destination === 'Big Sur' && trip?.cells.start_date === '2026-08-10' && trip?.cells.end_date === '2026-08-11' && trip?.cells.notes === '' && trip?.cells.created_ms > 0 && trip?.cells._created_at > 0, 'the trip is a row of the space, in the shape installed copies hold');
  expect(await keeper.until('the trip to open', `document.querySelector('h1.t-title input')?.value === 'Big Sur' && document.querySelectorAll('.day').length === 2`), 'the only trip opens by itself, a day for each day of it');

  // ----- the itinerary, typed in
  await keeper.fill('.day:nth-child(1) .f-time', '09:00');
  await keeper.fill('.day:nth-child(1) .f-act', 'Bixby Bridge');
  await keeper.press('Enter');
  const bixby = await untilRows('the first stop', 'trip_itinerary', (r) => r.find((x) => x.cells.activity === 'Bixby Bridge'));
  expect(bixby?.cells.trip_id === trip?.id && bixby?.cells.day_date === '2026-08-10' && bixby?.cells.time === '09:00' && bixby?.cells.sort_order === 0 && bixby?.cells.geo_q === '', 'a stop typed in is kept on its day, first');
  expect(await keeper.until('the stop to draw', `${acts} === 'Bixby Bridge' && document.querySelector('.day:nth-child(1) .f-act').value === ''`), 'and drawn, the add row emptied');
  await keeper.fill('.day:nth-child(1) .f-act', 'Lunch');
  await keeper.fill('.day:nth-child(1) .f-loc', 'Nepenthe');
  await keeper.press('Enter');
  const lunch = await untilRows('the place to be looked up', 'trip_itinerary', (r) => r.find((x) => x.cells.activity === 'Lunch' && x.cells.geo_q === 'Nepenthe'));
  expect(lunch?.cells.sort_order === 1, 'a second stop goes after the first, and its place is looked up once');
  if (offline) expect(lunch?.cells.lat === 0 && lunch?.cells.lon === 0 && !await keeper.inFrame(`return !!document.querySelector('.tmap')`), 'offline, nothing is found and no empty map is drawn');
  expect(await keeper.until('both stops', `${acts} === 'Bixby Bridge|Lunch' && /Nepenthe/.test(${text('.it-loc')})`), 'both stops are drawn in order');
  await keeper.shot('2-itinerary');

  // dragged by its grip above the first
  const grip = await at(keeper, `.it-row[data-id="${lunch?.id}"] .it-grip`);
  const first = await at(keeper, `.it-row[data-id="${bixby?.id}"]`);
  if (grip && first) await drag(keeper, grip, { x: first.x, y: first.top + 2 });
  expect(await untilRows('the reorder', 'trip_itinerary', (r) => {
    const o = (id) => r.find((x) => x.id === id)?.cells.sort_order;
    return o(lunch?.id) === 0 && o(bixby?.id) === 1;
  }), 'a stop dragged above another is kept first');
  expect(await keeper.until('the order to follow', `${acts} === 'Lunch|Bixby Bridge'`), 'and drawn first');

  // edited in its dialog
  await keeper.click(`.it-row[data-id="${bixby?.id}"] .it-act`);
  if (!await keeper.until('the entry dialog', `/Edit entry/.test(document.body.textContent) && !!document.querySelector('.ed input')`)) return;
  await keeper.fill('.ed input[placeholder="10:00 or all day"]', '08:30');
  await keeper.inFrame(`document.querySelector('.ed input[placeholder="10:00 or all day"]').blur(); return true;`);
  const edited = await untilRows('the time', 'trip_itinerary', (r) => r.find((x) => x.id === bixby?.id && x.cells.time === '08:30'));
  expect(edited?.cells.activity === 'Bixby Bridge' && edited?.cells._created_at === bixby?.cells._created_at, 'a time changed in the dialog lands over the row as it was');
  await keeper.shot('3-edit-entry');
  await keeper.click('.ed-del + button');
  expect(await keeper.until('the dialog to close', `!document.querySelector('.ed')`), 'Done closes the dialog');

  // ----- a stop with a place on the map
  await seed('trip_itinerary', 'pinned', { trip_id: trip?.id, day_date: '2026-08-11', time: '', activity: 'McWay Falls', location: 'McWay Falls', sort_order: 0, lat: 36.158, lon: -121.672, geo_q: 'McWay Falls', _created_at: 1, _modified_at: 1 });
  await reload(keeper);
  // online, Nepenthe is found too and pinned first
  const mcway = `[...document.querySelectorAll('.tmap .pin')].find((p) => p.title === 'McWay Falls · McWay Falls')`;
  expect(await keeper.until('the map and its pin', `!!${mcway} && !!document.querySelector('.tmap.maplibregl-map canvas')`), 'a stop with a place is pinned on a map above the days');
  expect(await keeper.inFrame(`return ${mcway}.textContent === String(document.querySelectorAll('.tmap .pin').length)${offline ? " && document.querySelectorAll('.tmap .pin').length === 1" : ''}`), 'the pin is numbered in trip order and named for its stop');
  await keeper.inFrame(`${mcway}.dataset.check = 'mcway'; return true;`);
  await keeper.click('.tmap .pin[data-check="mcway"]');
  expect(await keeper.until('the row to light', `document.querySelector('.it-row.sel')?.dataset.id === 'pinned'`), 'a pin clicked points at its stop');
  if (offline) {
    expect(await keeper.inFrame(`const r = await seamside.fetch('/tiles/styles/positron'); return r.status === 502 && r.text() === 'map tiles unreachable';`), "offline, the map's route says it cannot reach OpenFreeMap");
  } else {
    expect(await keeper.until('the map to load', `/OpenStreetMap/.test(document.querySelector('.tmap .maplibregl-ctrl-attrib')?.textContent ?? '')`, 80), "the map's style and tiles arrive through the worker");
  }
  await keeper.shot('4-map');

  // ----- packing
  await keeper.click('.seg button:nth-child(2)');
  if (!await keeper.until('the packing list', `!!document.querySelector('.pack-add .f-item')`)) return;
  await keeper.fill('.pack-add .f-item', 'Jacket');
  await keeper.fill('.pack-add .f-cat', 'clothes');
  await keeper.press('Enter');
  const jacket = await untilRows('the item', 'trip_packing', (r) => r.find((x) => x.cells.item === 'Jacket'));
  expect(jacket?.cells.category === 'clothes' && jacket?.cells.packed === 0 && jacket?.cells.trip_id === trip?.id, 'an item is kept under its category, not packed');
  await keeper.fill('.pack-add .f-item', 'Headlamp');
  await keeper.clear('.pack-add .f-cat');
  await keeper.press('Enter');
  expect((await untilRows('the second item', 'trip_packing', (r) => r.find((x) => x.cells.item === 'Headlamp')))?.cells.category === 'general', 'an item with no category is general');
  expect(await keeper.until('both items', `document.querySelectorAll('.pack-row').length === 2 && /0 of 2 packed/.test(${text('.pack-progress')})`), 'both are listed, none packed');
  await keeper.click('.pack-row input[type="checkbox"]');
  expect(await untilRows('packed', 'trip_packing', (r) => r.filter((x) => x.cells.packed === 1).length === 1), 'a box ticked is packed');
  expect(await keeper.until('the count', `/1 of 2 packed/.test(${text('.pack-progress')}) && document.querySelectorAll('.pack-row.packed').length === 1`), 'and counted');
  await keeper.shot('5-packing');

  // ----- costs
  await keeper.click('.seg button:nth-child(3)');
  if (!await keeper.until('the costs', `!!document.querySelector('.exp-add .f-desc')`)) return;
  await keeper.fill('.exp-add .f-desc', 'Gas');
  await keeper.fill('.exp-add .f-amt', '40.456');
  await setDate(keeper, '.exp-add .f-date', '2026-08-10');
  await keeper.click('.exp-add .f-desc');
  await keeper.press('Enter');
  const gas = await untilRows('the cost', 'trip_expenses', (r) => r.find((x) => x.cells.description === 'Gas'));
  expect(gas?.cells.amount === 40.46 && gas?.cells.category === 'other' && gas?.cells.date === '2026-08-10', 'a cost is kept to the cent, on its day');
  await keeper.fill('.exp-add .f-desc', 'Nothing');
  await keeper.fill('.exp-add .f-amt', '0');
  await keeper.press('Enter');
  await sleep(500);
  expect((await rows('trip_expenses')).length === 1, 'a cost of nothing is not kept');
  expect(await keeper.until('the total', `${text('.exp-total .amt')} === (40.46).toLocaleString(undefined, { minimumFractionDigits: 2 })`), 'the total adds up');
  await keeper.shot('6-costs');

  // ----- the trip's details
  await keeper.click('button.trip-edit');
  if (!await keeper.until('the trip dialog', `/Trip details/.test(document.body.textContent) && !!document.querySelector('.ed textarea')`)) return;
  await keeper.fill('.ed textarea', 'Fog likely');
  await keeper.inFrame(`document.querySelector('.ed textarea').blur(); return true;`);
  const noted = await untilRows('the notes', 'trips', (r) => r.find((x) => x.id === trip?.id && x.cells.notes === 'Fog likely'));
  expect(noted?.cells.name === 'Big Sur' && noted?.cells.created_ms === trip?.cells.created_ms, 'notes land over the trip as it was');
  await keeper.click('.ed-del + button');
  await keeper.until('the dialog to close', `!document.querySelector('.ed')`);
  await keeper.click('.seg button:nth-child(1)');

  // ----- a stranger at the published address
  const visitor = await open();
  if (!await visitor.until('the trip to open', `${text('h1.t-title .static')} === 'Big Sur'`)) return;
  expect(await visitor.inFrame(`return /You're viewing this trip plan publicly/.test(${text('.banner')}) && ${text('.header .mode')} === 'viewer'`), 'a stranger is told the plan is read-only');
  expect(await visitor.inFrame(`return !document.querySelector('.it-add, .it-grip, button.trip-edit, h1.t-title input') && ${acts} === 'Lunch|Bixby Bridge|McWay Falls'`), 'and is shown the itinerary with nothing to change');
  expect(await visitor.until('the map', `!!${mcway}`), 'the map included');
  await visitor.click(`.it-row[data-id="${bixby?.id}"]`);
  await sleep(300);
  expect(!await visitor.inFrame(`return !!document.querySelector('.ed')`), 'a stop clicked opens nothing for a stranger');
  await visitor.shot('7-stranger');

  // nobody touches the stranger's page: the push brings the keeper's change to it
  await keeper.fill('.day:nth-child(2) .f-act', 'Pfeiffer Beach');
  await keeper.press('Enter');
  expect(await visitor.until('the new stop to arrive', `/Pfeiffer Beach/.test(${acts})`), "a stranger's open page follows the keeper's edit");
  await visitor.click('.seg button:nth-child(2)');
  expect(await visitor.until('the packing list', `document.querySelectorAll('.pack-row').length === 2`), 'a stranger reads the packing list');
  expect(await visitor.inFrame(`return [...document.querySelectorAll('.pack-row input')].every((c) => c.disabled) && !document.querySelector('.pack-add, .trash')`), 'and ticks nothing');
  await visitor.click('.pack-row:not(.packed) .pi');
  await sleep(500);
  expect((await rows('trip_packing')).filter((x) => x.cells.packed === 1).length === 1, 'a stranger clicking an item packs nothing');

  // ----- the trip goes
  await keeper.click('button.trip-edit');
  await keeper.until('the trip dialog', `!!document.querySelector('.ed-del')`);
  await keeper.click('.ed-del');
  expect(await keeper.until('the delete to arm', `${text('.ed-del')} === 'Click again to delete'`), 'Delete trip asks once more');
  await keeper.click('.ed-del');
  expect(await untilRows('the trip to go', 'trips', (r) => r.length === 0 && [])
    && await untilRows('its stops to go', 'trip_itinerary', (r) => r.length === 0 && [])
    && await untilRows('its packing to go', 'trip_packing', (r) => r.length === 0 && [])
    && await untilRows('its costs to go', 'trip_expenses', (r) => r.length === 0 && []), 'a trip deleted takes everything of it');
  expect(await keeper.until('the list again', `/Plan your first trip/.test(document.body.textContent)`), 'the keeper is back at the first-trip form');
  expect(await visitor.until('the stranger to follow', `/Nothing here yet/.test(document.body.textContent)`), "and the stranger's page follows");
  await visitor.shot('8-gone');
};
