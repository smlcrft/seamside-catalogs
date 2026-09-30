// Garden Planner in the viewer: the keeper lays the garden out, a stranger is shown the
// layout only while the owner allows it, and never a name.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const shown = (sel) => `!!document.querySelector('${sel}') && !document.querySelector('${sel}').closest('.hidden')`;
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '').trim()`;
  const at = (b, sel) => b.inFrame(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };`);
  const drag = async (b, from, to) => {
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', buttons, clickCount: 1 }, b.child);
    await mouse('mousePressed', from, 1);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4 }, 1);
    await mouse('mouseReleased', to, 0);
    await sleep(400);
  };

  // ----- first run: no members list yet, then the settings
  if (!await keeper.until('the list chooser', `!!document.querySelector('.framelib-choose')`)) return;
  expect(await keeper.inFrame(`return /There is no members list in this space yet/.test(document.body.innerText)`), 'an editor with no list bound is asked for one');
  await keeper.shot('1-choose-list');
  await keeper.click('.framelib-dialog-host .framelib-btn-ghost');
  expect(await keeper.until('the settings to open', shown('#settings-overlay')), 'the owner with no location set is shown the settings');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.canvas')).position !== 'static' && document.styleSheets.length >= 2`), 'the page has its style');
  expect(await keeper.inFrame(`return ${text('#role-label')} === 'owner'`), 'the keeper is the owner');
  await keeper.shot('2-settings');

  const visitor = await open();
  if (!await visitor.until('the garden to draw', `/Public view of the garden is disabled/.test(document.body.innerText)`)) return;
  expect(await visitor.inFrame(`return ${text('#role-label')} === 'viewer' && !(${shown('#mode-btn')}) && !(${shown('#settings-btn')}) && !document.querySelector('.list-line__change')`), 'a stranger is a viewer with nothing to change');
  await visitor.shot('3-public-off');

  await keeper.fill('#cfg-org', 'Creek Garden');
  await keeper.fill('#cfg-cols', '20');
  await keeper.click('#cfg-allow-public');
  await keeper.click('#settings-save');
  expect(await keeper.until('the name to follow', `${text('#org-name')} === 'Creek Garden' && !(${shown('#settings-overlay')})`), 'the settings are kept and the page follows');
  expect(await keeper.inFrame(`return document.querySelector('#canvas').style.width === '640px'`), 'the grid is the size that was set');
  // nobody touches the stranger's page: the push has it read again
  expect(await visitor.until('the garden to open', `${text('#org-name')} === 'Creek Garden' && /No plots yet/.test(${text('#empty-text')})`), "a stranger's open page follows the settings, and is shown the garden");

  // ----- a members list, chosen from the space's own
  await seed('members', 'm1', { name: 'Ada Grower', role: 'grower' });
  await keeper.click('.list-line__change');
  if (!await keeper.until('the lists', `/1 person/.test(document.querySelector('.framelib-choose')?.innerText ?? '')`)) return;
  await keeper.shot('4-lists');
  await keeper.click('.framelib-choose-opt');
  expect(await keeper.until('the list to be named', `${text('.list-line strong')} === 'members'`), 'the list chosen is the list in use');

  // ----- a plot, by the button
  await keeper.click('#mode-btn');
  expect(await keeper.until('edit mode', `${shown('#add-btn')} && ${text('#mode-label')} === 'done'`), 'edit mode offers add plot');
  await keeper.click('#add-btn');
  await keeper.until('the plot dialog', shown('#edit-overlay'));
  expect(await keeper.inFrame(`return [...document.querySelectorAll('#edit-member option')].map((o) => o.textContent).join() === 'Ada Grower · grower'`), 'the roster is offered');
  await keeper.fill('#edit-name', 'North bed');
  await keeper.click('#shade-mode [data-shade="50"]');
  await keeper.click('.plant-row[data-plant="tomatoes"] input[type="checkbox"]');
  await keeper.inFrame(`const s = document.querySelector('.plant-row[data-plant="tomatoes"] .plant-stage'); s.value = 'sprout'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await keeper.fill('#edit-notes', 'by the gate');
  await keeper.shot('5-new-plot');
  await keeper.click('#edit-save');
  const north = await untilRows('the plot', '_fdata/garden_plots', (r) => r.find((x) => x.cells.name === 'North bed'));
  expect(north?.cells.pos_json === '{"x":0,"y":0,"w":3,"h":2}' && north?.cells.assigned_member_id === 'm1' && north?.cells.shade_pct === 50
    && north?.cells.plant_types_json === '[{"plant_type":"tomatoes","planted_at":null,"planted_stage":"sprout"}]' && north?.cells.notes === 'by the gate'
    && north?.cells._created_at > 0 && north?.cells._modified_at > 0, 'the plot is a row of the space');
  expect(await keeper.until('the plot to draw', `${text('.plot .plot-name')} === 'North bed' && ${text('.plot .plot-meta')} === 'Ada Grower' && !(${shown('#edit-overlay')})`), 'and drawn from what the worker answers');
  expect(await visitor.until('the plot to arrive by itself', `${text('.plot .plot-name')} === 'North bed'`), "the stranger's page is told of the plot");
  expect(await visitor.inFrame(`return !document.querySelector('.plot .plot-meta') && !/Ada/.test(document.body.innerText)`), 'and shown no name');

  // ----- moved by dragging
  let p = await at(keeper, '.plot');
  await drag(keeper, { x: p.x + p.w / 2, y: p.y + p.h / 2 }, { x: p.x + p.w / 2 + 64, y: p.y + p.h / 2 + 32 });
  const moved = await untilRows('the move', '_fdata/garden_plots', (r) => r.find((x) => x.id === north?.id && x.cells.pos_json === '{"x":2,"y":1,"w":3,"h":2}'));
  expect(moved?.cells.name === 'North bed' && moved?.cells.notes === 'by the gate' && moved?.cells._created_at === north?.cells._created_at, 'a plot dragged is kept where it was dropped, over the row as it was');

  // ----- a second, drawn on the empty canvas, for someone not on the roster
  const c = await at(keeper, '#canvas');
  await drag(keeper, { x: c.x + 32 * 8 + 5, y: c.y + 32 * 4 + 5 }, { x: c.x + 32 * 10 - 5, y: c.y + 32 * 7 - 5 });
  expect(await keeper.until('the new plot dialog', `${shown('#edit-overlay')} && ${text('#edit-title')} === 'New plot'`), 'a rectangle drawn on the canvas asks what it is');
  await keeper.fill('#edit-name', 'Guest bed');
  await keeper.click('#assign-mode [data-mode="manual"]');
  await keeper.fill('#edit-manual', 'Anna');
  await keeper.click('#edit-save');
  const guest = await untilRows('the second plot', '_fdata/garden_plots', (r) => r.find((x) => x.cells.name === 'Guest bed'));
  expect(guest?.cells.pos_json === '{"x":8,"y":4,"w":2,"h":3}' && guest?.cells.assigned_manual_name === 'Anna' && guest?.cells.assigned_member_id === '' && guest?.cells.shade_pct === 100, 'it is kept at the size it was drawn');
  expect(await keeper.until('both plots', `document.querySelectorAll('.plot').length === 2 && ${text('#count-badge')} === '2'`), 'and both are drawn');
  await keeper.shot('6-garden');

  // ----- what a stranger may open
  expect(await visitor.until('both plots', `document.querySelectorAll('.plot').length === 2`), 'the stranger has both plots');
  await visitor.click('.plot');
  await visitor.until('the detail', shown('#detail-overlay'));
  expect(await visitor.inFrame(`const t = document.querySelector('#detail-body').innerText; return /Tomatoes/.test(t) && /part shade/.test(t) && !/Owned by|Ada|by the gate/i.test(t) && !(${shown('#detail-edit')});`), 'a plot opened by a stranger says what grows there and not whose it is');
  await visitor.shot('7-public-detail');
  await visitor.click('#detail-cancel');

  // ----- taken out
  await keeper.click('.plot[data-row="' + guest?.id + '"] .plot-name');
  await keeper.until('the plot dialog', `${shown('#edit-overlay')} && ${text('#edit-title')} === 'Edit plot'`);
  await keeper.click('#edit-delete');
  expect(await keeper.until('to be asked', `/Delete "Guest bed"\\?/.test(document.querySelector('.framelib-dialog-host')?.innerText ?? '')`), 'a delete asks first');
  await keeper.click('.framelib-dialog-host .framelib-btn-danger');
  for (let i = 0; i < 40 && (await rows('_fdata/garden_plots')).length !== 1; i++) await sleep(250);
  expect((await rows('_fdata/garden_plots')).length === 1, 'the plot is gone from the space');
  expect(await keeper.until('one plot', `document.querySelectorAll('.plot').length === 1`), "and from the keeper's page");
  expect(await visitor.until('one plot', `document.querySelectorAll('.plot').length === 1 && ${text('#count-badge')} === '1'`), "and from the stranger's");

  // ----- public viewing off again
  await keeper.click('#settings-btn');
  await keeper.until('the settings', shown('#settings-overlay'));
  expect(await keeper.inFrame(`return document.querySelector('#cfg-allow-public').checked && document.querySelector('#cfg-org').value === 'Creek Garden' && document.querySelector('#cfg-cols').value === '20'`), 'the settings say what was kept');
  await keeper.click('#cfg-allow-public');
  await keeper.click('#settings-save');
  expect(await visitor.until('the garden to close', `/Public view of the garden is disabled/.test(document.body.innerText) && document.querySelectorAll('.plot').length === 0`), 'public viewing turned off takes the garden from the stranger');
  await visitor.shot('8-public-off-again');
  await keeper.shot('9-keeper-end');
};
