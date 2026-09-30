// Habit Tracker in the viewer: the keeper keeping habits, a stranger watching the grid.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const p2 = (n) => String(n).padStart(2, '0');
  const ago = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
  const today = ago(0), yesterday = ago(1);

  // Mark the card that names a habit, so a selector can say it; asked again before each use.
  const card = async (b, name) => (await b.inFrame(`
    const el = [...document.querySelectorAll('.card')].find((c) => c.querySelector('.h-name')?.textContent === ${JSON.stringify(name)});
    document.querySelectorAll('[data-check]').forEach((e) => e.removeAttribute('data-check'));
    if (el) el.setAttribute('data-check', 'this');
    return !!el;`)) ? '[data-check="this"]' : '.card[data-nothing-matched]';
  const said = (b) => b.inFrame(`return document.querySelector('main')?.textContent ?? ''`);
  const runOf = (name) => `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.h-name')?.textContent === ${JSON.stringify(name)})?.querySelector('.fig .n')?.textContent`;
  const doneOf = (name) => `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.h-name')?.textContent === ${JSON.stringify(name)})?.classList.contains('done')`;
  const marksOf = (r, id) => r.filter((m) => m.cells.habit_id === id).map((m) => m.cells.day).sort().join(',');

  if (!await keeper.until('the page to draw', `!!document.querySelector('main .add input')`)) return;
  expect(/Nothing tracked yet\. Name one thing below\./.test(await said(keeper)), 'the keeper has an empty grid and the box to start it');
  expect(await keeper.inFrame(`return !document.querySelector('.banner') && document.querySelector('.header .mode').textContent !== 'viewer'`), 'with no read-only banner');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('main')).display === 'flex' && getComputedStyle(document.querySelector('.add')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-empty');

  // a habit already kept in the frame data, three days running, then one typed with Enter
  await seed('_fdata/habits', 'old1', { name: 'Read', sort_order: 0, created_ms: 5, _created_at: 5, _modified_at: 5 });
  for (const [id, n] of [['m0', 0], ['m1', 1], ['m2', 2]]) {
    await seed('_fdata/habit_marks', id, { habit_id: 'old1', day: ago(n), made_ms: 6, _created_at: 6, _modified_at: 6 });
  }
  await keeper.fill('.add input', 'Meditate');
  await keeper.press('Enter');
  const med = await untilRows('the habit', '_fdata/habits', (r) => r.find((x) => x.cells.name === 'Meditate'));
  expect(med?.cells.sort_order === 1 && med?.cells.created_ms > 0 && med?.cells._created_at && med?.cells._modified_at, 'Enter adds a habit, last, a row of the space in its old shape');
  expect(await keeper.until('both to draw', `document.querySelectorAll('.card').length === 2 && document.querySelectorAll('.h-name')[0].textContent === 'Read' && document.querySelectorAll('.h-name')[1].textContent === 'Meditate'`), 'the grid draws it after the one left behind');
  expect(await keeper.inFrame(`return document.querySelector('.add input').value === ''`), 'and the box is cleared');
  expect(await keeper.inFrame(`return ${runOf('Read')} === '3' && ${doneOf('Read')} && ${runOf('Meditate')} === '0' && !${doneOf('Meditate')}`), 'the old habit shows its three-day run, done today');
  expect(/1 of 2 so far today\./.test(await said(keeper)), 'and the line says where the day stands');

  // today's check marks it
  await keeper.click(`${await card(keeper, 'Meditate')} .today`);
  expect(await untilRows('the mark', '_fdata/habit_marks', (r) => marksOf(r, med?.id) === today), "today's check writes one mark for today");
  expect(await keeper.until('the day to be done', `${doneOf('Meditate')} && ${runOf('Meditate')} === '1'`), 'and the card is done with a run of one');
  expect(/All 2 done today\./.test(await said(keeper)), 'the line says all are done');
  const mark = (await rows('_fdata/habit_marks')).find((m) => m.cells.habit_id === med?.id);
  expect(mark?.cells.made_ms > 0 && mark?.cells._created_at && mark?.cells._modified_at, 'the mark is a row in its old shape');

  // yesterday, filled in on the trail
  await keeper.click(`${await card(keeper, 'Meditate')} .trail .cell:nth-child(13)`);
  expect(await untilRows('yesterday', '_fdata/habit_marks', (r) => marksOf(r, med?.id) === `${yesterday},${today}`), 'a square on the trail fills in yesterday');
  expect(await keeper.until('the run to grow', `${runOf('Meditate')} === '2'`), 'and the run grows to two');
  await sleep(300);
  expect((await rows('_fdata/habit_marks')).length === 5, 'nothing is marked twice');
  await keeper.shot('2-marked');

  // today taken back on the old habit: the run stands until the day is over
  await keeper.click(`${await card(keeper, 'Read')} .today`);
  expect(await untilRows('the undo', '_fdata/habit_marks', (r) => marksOf(r, 'old1') === `${ago(2)},${yesterday}`), "pressing a done day's check takes the mark back");
  expect(await keeper.until('the card to settle', `!${doneOf('Read')} && ${runOf('Read')} === '2'`), 'and the run counts back from yesterday');
  expect(/1 of 2 so far today\./.test(await said(keeper)), 'the line follows');

  // renamed through the habit's own menu
  await keeper.click(`${await card(keeper, 'Meditate')} .h-name`);
  if (!await keeper.until('the menu', `document.querySelectorAll('.framelib-choose-opt').length === 2`)) return;
  expect(await keeper.inFrame(`return /Rename/.test(document.querySelectorAll('.framelib-choose-opt')[0].textContent) && /Its marks go too/.test(document.querySelectorAll('.framelib-choose-opt')[1].textContent)`), 'a habit\'s name offers Rename and Remove');
  await keeper.shot('3-menu');
  await keeper.click('.framelib-choose-opt:nth-child(1)');
  if (!await keeper.until('the name to be asked', `document.querySelector('.framelib-prompt-input')?.value === 'Meditate'`)) return;
  await keeper.fill('.framelib-prompt-input', 'Sit still');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  expect(await untilRows('the rename', '_fdata/habits', (r) => r.find((x) => x.id === med?.id && x.cells.name === 'Sit still' && x.cells.sort_order === 1 && x.cells._created_at === med?.cells._created_at)), 'Save renames it over the row');
  expect(await keeper.until('the new name', `${runOf('Sit still')} === '2'`), 'and the page draws it with its run');

  // a stranger at the published address watches, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the grid to draw for a stranger', `document.querySelectorAll('.card').length === 2`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && /You are watching this\\./.test(document.querySelector('.banner')?.textContent ?? '') && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger is told the grid is theirs to watch');
  expect(await visitor.inFrame(`return !document.querySelector('.add') && [...document.querySelectorAll('.today, .cell, .h-name')].every((b) => b.disabled)`), 'and has no box, and nothing to press');
  expect(await visitor.inFrame(`return ${runOf('Sit still')} === '2' && ${doneOf('Sit still')} && ${runOf('Read')} === '2' && !${doneOf('Read')}`), 'the stranger sees the grid as it stands');
  await visitor.shot('4-stranger');
  await visitor.click(`${await card(visitor, 'Read')} .today`);
  await sleep(400);
  expect(marksOf(await rows('_fdata/habit_marks'), 'old1') === `${ago(2)},${yesterday}`, "a stranger's press changes nothing");

  // nobody touches the stranger's page: the push says to read again
  await keeper.fill('.add input', 'Walk');
  await keeper.press('Enter');
  const walk = await untilRows('the new habit', '_fdata/habits', (r) => r.find((x) => x.cells.name === 'Walk'));
  expect(walk?.cells.sort_order === 2, 'the keeper adds a habit');
  expect(await visitor.until('it to reach the stranger', `document.querySelectorAll('.card').length === 3 && ${runOf('Walk')} === '0'`), "and the stranger's open page is told to read again");
  await keeper.click(`${await card(keeper, 'Walk')} .today`);
  await untilRows('the walk', '_fdata/habit_marks', (r) => marksOf(r, walk?.id) === today);
  expect(await visitor.until('the mark to reach the stranger', `${doneOf('Walk')} && /2 of 3 so far today\\./.test(document.querySelector('main').textContent)`), 'a mark fills in on the stranger\'s grid too');

  // removed, marks and all, after a question
  await keeper.click(`${await card(keeper, 'Walk')} .h-name`);
  await keeper.until('the menu', `document.querySelectorAll('.framelib-choose-opt').length === 2`);
  await keeper.click('.framelib-choose-opt:nth-child(2)');
  expect(await keeper.until('to be asked', `/Remove "Walk" and everything marked for it\\?/.test(document.querySelector('.framelib-dialog-host')?.textContent ?? '')`), 'a remove asks first');
  await sleep(300);
  expect((await rows('_fdata/habits')).some((x) => x.cells.name === 'Walk'), 'and removes nothing yet');
  await keeper.shot('5-confirm');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  expect(await untilRows('the remove', '_fdata/habits', (r) => r.length === 2 && !r.some((x) => x.cells.name === 'Walk')), 'Remove takes the habit');
  expect(await untilRows('its marks to go', '_fdata/habit_marks', (r) => !r.some((m) => m.cells.habit_id === walk?.id)), 'and its marks');
  expect(await keeper.until('it to go', `document.querySelectorAll('.card').length === 2`), 'it is gone from the page');
  expect(await visitor.until('it to go for the stranger', `document.querySelectorAll('.card').length === 2`), "and from the stranger's");
  await keeper.shot('6-after');
  await visitor.shot('7-stranger-after');
};
