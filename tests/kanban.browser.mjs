// Kanban Board in the viewer: the keeper works the board by clicks, typing and dragging;
// a stranger at the published address follows it live and changes nothing.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '').trim()`;
  const titles = `[...document.querySelectorAll('.col')].map((c) => c.querySelector('.col-title input, .col-title .static').value ?? c.querySelector('.col-title .static').textContent).join('|')`;
  const cardsOf = (id) => `[...document.querySelectorAll('.col[data-id="${id}"] .card .card-title')].map((t) => t.textContent).join('|')`;
  const at = (b, sel) => b.inFrame(`
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, left: r.left, w: r.width, h: r.height };`);
  // An HTML drag, as a person makes one: pressed, carried, let go. The browser hands a
  // drag to the system, so it is held here and carried over the page as drag events.
  const drag = async (b, from, to) => {
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', buttons, clickCount: 1 }, b.child);
    const carry = (type, p) => b.send('Input.dispatchDragEvent', { type, x: Math.round(p.x), y: Math.round(p.y), data: { items: [], dragOperationsMask: 16 } }, b.child);
    await b.send('Input.setInterceptDrags', { enabled: true }, b.child);
    await mouse('mouseMoved', from, 0);
    await mouse('mousePressed', from, 1);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', { x: from.x + 4 * i, y: from.y + 4 * i }, 1);
    await carry('dragEnter', to);
    for (let i = 0; i < 3; i++) { await carry('dragOver', to); await sleep(50); }
    await carry('drop', to);
    await mouse('mouseReleased', to, 0);
    await b.send('Input.setInterceptDrags', { enabled: false }, b.child);
    await sleep(500);
  };

  // ----- the keeper's first look seeds the three classic columns
  if (!await keeper.until('the board to draw', `document.querySelectorAll('.col').length === 3`)) return;
  expect(await keeper.inFrame(`return ${titles} === 'To do|In progress|Done'`), 'an empty board opens with To do, In progress and Done');
  expect(await keeper.inFrame(`return ${text('.header .mode')} === 'owner' && !document.querySelector('.banner') && !!document.querySelector('.new-col input')`), 'the keeper is the owner, with the board to edit');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.col')).display === 'flex' && document.styleSheets.length >= 2`), 'the page has its style');
  const seeded = await untilRows('the seeded columns', 'kanban_columns', (r) => r.length === 3 && r);
  const col = (t) => seeded?.find((x) => x.cells.title === t)?.id;
  const [todo, doing, done] = [col('To do'), col('In progress'), col('Done')];
  expect(seeded?.find((x) => x.id === todo)?.cells.channel === 'c2' && seeded?.find((x) => x.id === done)?.cells.sort_order === 2, 'as rows of the space');
  await keeper.shot('1-seeded');

  const visitor = await open();
  if (!await visitor.until('the board to draw for a stranger', `document.querySelectorAll('.col').length === 3`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && /viewing this board publicly/.test(${text('.banner')}) && !document.querySelector('.new-col, .col-add, .col-grip, .col-title input') && document.querySelector('.col-dot').disabled`), 'a stranger has the board read-only');
  expect(await visitor.inFrame(`return ${text('.header .mode')} === 'viewer'`), 'and is a viewer');
  await visitor.shot('2-stranger');

  // ----- cards, by the header +
  await keeper.click(`.col[data-id="${todo}"] .col-add`);
  await keeper.until('the draft', `document.activeElement?.closest('.card-draft')`);
  await keeper.fill(`.col[data-id="${todo}"] .card-draft input`, 'Write the plan');
  await keeper.press('Enter');
  const plan = await untilRows('the card', 'kanban_cards', (r) => r.find((x) => x.cells.title === 'Write the plan'));
  expect(plan?.cells.column_id === todo && plan?.cells.description === '' && plan?.cells.label === '' && plan?.cells.created_ms > 0 && plan?.cells._created_at > 0 && plan?.cells._modified_at > 0, 'a card typed in is a row of the space');
  await keeper.fill(`.col[data-id="${todo}"] .card-draft input`, 'Buy paint');
  await keeper.press('Enter');
  await untilRows('the second card', 'kanban_cards', (r) => r.length === 2);
  await keeper.press('Escape');
  expect(await keeper.until('both cards, the newest first', `${cardsOf(todo)} === 'Buy paint|Write the plan' && !document.querySelector('.card-draft')`), 'the + puts a card at the top');
  expect(await visitor.until('the cards to arrive by themselves', `${cardsOf(todo)} === 'Buy paint|Write the plan'`), "the stranger's open page is told of them");
  await keeper.shot('2-cards');

  // ----- a card's details
  await keeper.inFrame(`[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Write the plan')).id = 'k-plan'; return true;`);
  await keeper.click('#k-plan');
  if (!await keeper.until('the editor', `${text('.framelib-modal-header h2')} === 'Edit card'`)) return;
  await keeper.fill('.ed div:nth-child(2) input', 'design');
  await keeper.press('Enter');
  await keeper.fill('.ed textarea', 'Three pages, no more.');
  await keeper.shot('3-editor');
  await keeper.inFrame(`[...document.querySelectorAll('.framelib-modal-actions button')].find((b) => b.textContent.trim() === 'Done').id = 'k-done'; return true;`);
  await keeper.click('#k-done');
  const edited = await untilRows('the details', 'kanban_cards', (r) => r.find((x) => x.id === plan?.id && x.cells.label === 'design' && x.cells.description === 'Three pages, no more.'));
  expect(edited?.cells.title === 'Write the plan' && edited?.cells.column_id === todo && edited?.cells._created_at === plan?.cells._created_at, 'a label and details are kept, over the row as it was');
  expect(await keeper.until('the card to show them', `!document.querySelector('.framelib-modal') && document.querySelector('#k-plan .card-label')?.textContent === 'design' && /Three pages/.test(document.querySelector('#k-plan .card-desc')?.textContent ?? '')`), 'the editor closes and the card shows its label');

  // ----- a column renamed, recoloured, added
  await keeper.fill(`.col[data-id="${doing}"] .col-title input`, 'Doing');
  await keeper.press('Enter');
  expect(await untilRows('the new name', 'kanban_columns', (r) => r.find((x) => x.id === doing && x.cells.title === 'Doing' && x.cells.channel === 'c4')), 'a column is renamed by typing over its name');
  await keeper.click(`.col[data-id="${doing}"] .col-dot`);
  await keeper.until('the swatches', `!!document.querySelector('.pop')`);
  await keeper.shot('4-swatches');
  await keeper.click('.pop-swatches button[title="c9"]');
  expect(await untilRows('the new colour', 'kanban_columns', (r) => r.find((x) => x.id === doing && x.cells.channel === 'c9' && x.cells.title === 'Doing')), 'and recoloured from its dot');
  await keeper.fill('.new-col input', 'Review');
  await keeper.press('Enter');
  const review = (await untilRows('the new column', 'kanban_columns', (r) => r.find((x) => x.cells.title === 'Review')))?.id;
  expect(await keeper.until('four columns', `${titles} === 'To do|Doing|Done|Review'`), 'a column typed in is added at the end');
  expect(await visitor.until('the columns to follow', `${titles} === 'To do|Doing|Done|Review' && document.querySelector('.col[data-id="${doing}"]').getAttribute('style').includes('--os-c9')`), "and the stranger's page follows, colour included");

  // ----- a card dragged to another column
  const from = await at(keeper, '#k-plan');
  const into = await at(keeper, `.col[data-id="${doing}"] .cards`);
  await drag(keeper, from, { x: into.x, y: into.top + 10 });
  const moved = await untilRows('the move', 'kanban_cards', (r) => r.find((x) => x.id === plan?.id && x.cells.column_id === doing));
  expect(moved?.cells.label === 'design' && moved?.cells.sort_order === 0, 'a card dragged to another column lands there, as it was');
  expect(await keeper.until('the card to move', `${cardsOf(doing)} === 'Write the plan' && ${cardsOf(todo)} === 'Buy paint'`), 'and the board shows it there');
  expect(await visitor.until('the move to arrive', `${cardsOf(doing)} === 'Write the plan'`), 'the stranger sees it moved');

  // ----- a column dragged by its grip, where both ends are in sight
  await keeper.inFrame(`document.querySelector('.board').scrollLeft = 0; return true;`);
  const grip = await at(keeper, `.col[data-id="${done}"] .col-grip`);
  const first = await at(keeper, `.col[data-id="${todo}"]`);
  await drag(keeper, grip, { x: first.left + 20, y: first.top + 20 });
  expect(await untilRows('the reorder', 'kanban_columns', (r) => {
    const o = (id) => r.find((x) => x.id === id)?.cells.sort_order;
    return o(done) === 0 && o(todo) === 1 && o(doing) === 2 && o(review) === 3;
  }), 'a column dragged to the front is kept first');
  expect(await keeper.until('the order to follow', `${titles} === 'Done|To do|Doing|Review'`), 'and drawn first');
  expect(await visitor.until('the order to arrive', `${titles} === 'Done|To do|Doing|Review'`), 'the stranger sees the new order');
  await keeper.shot('5-dragged');

  // ----- what a stranger may open
  await visitor.inFrame(`[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Write the plan')).id = 'v-plan'; return true;`);
  await visitor.click('#v-plan');
  expect(await visitor.until('the card', `${text('.framelib-modal-header h2')} === 'Card'`), 'a stranger opens a card to read');
  expect(await visitor.inFrame(`const m = document.querySelector('.framelib-modal'); return /Three pages, no more\\./.test(m.textContent) && /design/.test(m.textContent) && !m.querySelector('input, textarea, .ed-del')`), 'with its details and nothing to change');
  await visitor.shot('6-stranger-card');
  await visitor.click('.framelib-modal-close');

  // ----- taken out
  await keeper.inFrame(`[...document.querySelectorAll('.card')].find((c) => c.textContent.includes('Buy paint')).id = 'k-paint'; return true;`);
  await keeper.click('#k-paint');
  await keeper.until('the editor', `!!document.querySelector('.ed-del')`);
  await keeper.click('.ed-del');
  expect(await keeper.until('to be asked again', `${text('.ed-del')} === 'Click again to delete'`), 'a delete asks first');
  await keeper.click('.ed-del');
  for (let i = 0; i < 40 && (await rows('kanban_cards')).length !== 1; i++) await sleep(250);
  expect((await rows('kanban_cards')).length === 1, 'the card is gone from the space');
  await keeper.click(`.col[data-id="${review}"] .col-dot`);
  await keeper.until('the swatches', `!!document.querySelector('.pop-del')`);
  await keeper.click('.pop-del');
  await keeper.click('.pop-del');
  for (let i = 0; i < 40 && (await rows('kanban_columns')).length !== 3; i++) await sleep(250);
  expect((await rows('kanban_columns')).length === 3, 'the column is gone from the space');
  expect(await keeper.until('the board to follow', `${titles} === 'Done|To do|Doing' && ${cardsOf(todo)} === ''`), "and from the keeper's board");
  expect(await visitor.until('the board to follow', `${titles} === 'Done|To do|Doing' && document.querySelectorAll('.card').length === 1`), "and from the stranger's");
  await visitor.shot('7-stranger-end');
  await keeper.shot('8-keeper-end');
};
