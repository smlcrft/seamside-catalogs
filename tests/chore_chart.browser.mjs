// Chore Chart in the viewer: the keeper adding, punching and changing chores; a stranger watching.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const card = (name) => `[...document.querySelectorAll('.card')].find((c) => c.querySelector('.c-name')?.textContent === ${JSON.stringify(name)})`;
  // mark the one element meant, inside one card, so a selector can say it
  const pick = (b, name, sel) => b.inFrame(`
    document.querySelectorAll('[data-pick]').forEach((e) => e.removeAttribute('data-pick'));
    const el = ${card(name)}?.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.setAttribute('data-pick', '');
    return true;`);
  const clickIn = async (b, name, sel) => (await pick(b, name, sel)) && b.click('[data-pick]');
  const choice = (label) => `[...document.querySelectorAll('.framelib-choose-opt')].find((o) => o.querySelector('.framelib-choose-label').textContent.trim() === ${JSON.stringify(label)})`;
  const choose = async (b, label) => {
    if (!await b.until(`the choice ${label}`, `!!${choice(label)}`)) return;
    await b.inFrame(`${choice(label)}.setAttribute('data-choice', ''); return true;`);
    await b.click('[data-choice]');
  };
  const byName = (r, name) => r.find((x) => x.cells.chore === name);
  const noon = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(12, 0, 0, 0); return d.getTime(); };
  const main = `document.querySelector('main')`;

  if (!await keeper.until('the chart to draw', `!!document.querySelector('main .add .f-chore')`)) return;
  expect(await keeper.inFrame(`return /No chores yet\\. Add the first one above\\./.test(${main}.textContent) && !${main}.classList.contains('read-only') && !document.querySelector('.banner')`), 'the keeper has an empty chart and the strip to start it');
  expect(await keeper.inFrame(`return getComputedStyle(${main}).display === 'flex' && getComputedStyle(document.querySelector('.add')).display === 'flex' && !document.querySelector('form')`), 'the page has its style and holds no form');
  await keeper.shot('1-empty');

  // a chore typed in, for a person, with the rhythm stepped round to daily
  expect(await keeper.inFrame(`return document.querySelector('.cadbtn').textContent.trim() === 'weekly'`), 'a new chore starts weekly');
  for (let i = 0; i < 3; i++) await keeper.click('.cadbtn');
  expect(await keeper.inFrame(`return document.querySelector('.cadbtn').textContent.trim() === 'daily'`), 'the rhythm steps weekly, monthly, once, daily');
  await keeper.fill('.add .f-chore', 'Dishes');
  await keeper.fill('.add .f-who', 'Ana');
  await keeper.press('Enter');
  const dishes = await untilRows('the chore', '_fdata/chores', (r) => byName(r, 'Dishes'));
  expect(dishes?.cells.assignee === 'Ana' && dishes?.cells.cadence === 'daily' && dishes?.cells.sort_order === 0 && dishes?.cells.last_done_ms === 0
    && dishes?.cells.streak === 0 && dishes?.cells.best_streak === 0 && dishes?.cells.notes === '' && dishes?.cells._created_at && dishes?.cells._modified_at,
  'Enter adds a chore, a row of the space from the contract\'s defaults, stamped');
  expect(await keeper.until('the card to draw', `!!${card('Dishes')}`), 'and the board draws its card');
  expect(await keeper.inFrame(`return document.querySelector('.add .f-chore').value === '' && document.querySelector('.add .f-who').value === 'Ana' && document.querySelector('.cadbtn').textContent.trim() === 'daily'`), 'the chore field is cleared, who and rhythm kept for the next');
  expect(await keeper.inFrame(`const c = ${card('Dishes')}; return c.querySelector('.who-name').textContent === 'Ana' && c.querySelector('.rhythm').textContent === 'daily' && c.querySelectorAll('.slot').length === 7 && c.querySelectorAll('.slot.live').length === 1 && !c.classList.contains('done')`), 'a daily card is a week of holes, one of them live');

  // rows other devices left: done yesterday on a run, done today, done long ago
  await seed('_fdata/chores', 'yday', { chore: 'Feed the cat', assignee: 'Bo', cadence: 'daily', last_done_ms: noon(1), last_done_by: 'Bo', streak: 3, best_streak: 3, sort_order: 1, notes: '', _created_at: 5, _modified_at: 5 });
  await seed('_fdata/chores', 'today', { chore: 'Water plants', assignee: 'Bo', cadence: 'daily', last_done_ms: noon(0) < Date.now() ? noon(0) : Date.now(), last_done_by: 'Bo', streak: 2, best_streak: 5, sort_order: 2, notes: '', _created_at: 6, _modified_at: 6 });
  await seed('_fdata/chores', 'lastwk', { chore: 'Bins', assignee: '', cadence: 'weekly', last_done_ms: noon(7), last_done_by: '', streak: 2, best_streak: 2, sort_order: 3, notes: '', _created_at: 7, _modified_at: 7 });
  await seed('_fdata/chores', 'long', { chore: 'Hoover', assignee: 'Cy', cadence: 'daily', last_done_ms: noon(3), last_done_by: 'Cy', streak: 6, best_streak: 6, sort_order: 4, notes: '', _created_at: 8, _modified_at: 8 });
  // one more typed, which reads the board again with them
  await keeper.fill('.add .f-chore', 'Sweep');
  await keeper.press('Enter');
  expect(await untilRows('the next chore', '_fdata/chores', (r) => byName(r, 'Sweep')?.cells.sort_order === 5 && byName(r, 'Sweep')?.cells.assignee === 'Ana'), 'the next chore goes after the last, for the same person');
  expect(await keeper.until('the seeded cards', `document.querySelectorAll('.card').length === 6`), 'the board draws the chores other devices left');
  expect(await keeper.inFrame(`return ${card('Water plants')}.classList.contains('done') && !${card('Feed the cat')}.classList.contains('done') && !${card('Hoover')}.classList.contains('done')`), 'done today is done, done yesterday or before is not');
  expect(await keeper.inFrame(`return document.querySelector('.progress span').textContent === '1 of 6 done' && document.querySelector('.cards .card:last-child .c-name').textContent === 'Water plants'`), 'the count says one done, and the done card steps to the end');
  expect(await keeper.inFrame(`const c = ${card('Water plants')}; return c.querySelectorAll('.slot.punched').length === 2 && c.querySelector('.slot.live').classList.contains('punched') && /best 5/.test(c.querySelector('.tally').textContent)`), 'a done card shows its run punched, the live hole the newest, and its best');
  await keeper.shot('2-board');

  // punching a chore done last period continues its run
  await clickIn(keeper, 'Feed the cat', '.slot.live');
  const fed = await untilRows('the punch', '_fdata/chores', (r) => r.find((x) => x.id === 'yday' && x.cells.streak === 4));
  expect(fed?.cells.best_streak === 4 && fed?.cells.last_done_ms > noon(0) - 12 * 3600e3 && fed?.cells.assignee === 'Bo' && fed?.cells._created_at === 5, 'a punch after yesterday\'s continues the run and raises the best, over the row');
  expect(await keeper.until('the card to settle', `${card('Feed the cat')}.classList.contains('done') && ${card('Feed the cat')}.querySelectorAll('.slot.punched').length === 4`), 'and the card is punched four times');
  // one done long ago starts over
  await clickIn(keeper, 'Hoover', '.slot.live');
  expect(await untilRows('the fresh run', '_fdata/chores', (r) => r.find((x) => x.id === 'long' && x.cells.streak === 1 && x.cells.best_streak === 6)), 'a punch after a gap starts the run at 1 and keeps the best');
  // a weekly one done last week continues too
  await clickIn(keeper, 'Bins', '.slot.live');
  expect(await untilRows('the weekly run', '_fdata/chores', (r) => r.find((x) => x.id === 'lastwk' && x.cells.streak === 3 && x.cells.best_streak === 3)), 'a weekly punch after last week\'s continues the run');
  expect(await keeper.until('the count to follow', `document.querySelector('.progress span').textContent === '4 of 6 done'`), 'and the count follows');
  await keeper.shot('3-punched');

  // the live hole of a done card undoes the punch
  await clickIn(keeper, 'Feed the cat', '.slot.live');
  const undone = await untilRows('the undo', '_fdata/chores', (r) => r.find((x) => x.id === 'yday' && x.cells.last_done_ms === 0));
  expect(undone?.cells.streak === 3 && undone?.cells.best_streak === 4 && undone?.cells.last_done_by === '', 'an undo gives back the run, and the best stays');
  expect(await keeper.until('the card to open again', `!${card('Feed the cat')}.classList.contains('done') && /best 4/.test(${card('Feed the cat')}.querySelector('.tally')?.textContent ?? '')`), 'and the card is open again, its best shown');
  await sleep(300);
  expect((await rows('_fdata/chores')).find((x) => x.id === 'today')?.cells.streak === 2, 'nothing touched the one done today');

  // the menu: rename
  await clickIn(keeper, 'Sweep', '.c-name');
  await choose(keeper, 'Rename');
  if (!await keeper.until('the rename prompt', `document.querySelector('.framelib-prompt-input')?.value === 'Sweep'`)) return;
  await keeper.fill('.framelib-prompt-input', 'Sweep the porch');
  await keeper.click('.framelib-btn-primary');
  expect(await untilRows('the rename', '_fdata/chores', (r) => r.find((x) => x.cells.chore === 'Sweep the porch' && x.cells.sort_order === 5 && x.cells.assignee === 'Ana')), 'a chore is renamed from its menu, over the row');
  expect(await keeper.until('the new name', `!!${card('Sweep the porch')}`), 'and the card says so');
  // who does it, from the person on the card
  await clickIn(keeper, 'Sweep the porch', '.who');
  if (!await keeper.until('the who prompt', `document.querySelector('.framelib-prompt-input')?.value === 'Ana'`)) return;
  await keeper.fill('.framelib-prompt-input', 'Dee');
  await keeper.press('Enter');
  expect(await untilRows('the person', '_fdata/chores', (r) => r.find((x) => x.cells.chore === 'Sweep the porch' && x.cells.assignee === 'Dee')), 'a chore is given to someone else');
  expect(await keeper.until('the badge', `${card('Sweep the porch')}?.querySelector('.who-name').textContent === 'Dee' && ${card('Sweep the porch')}.querySelector('.badge').textContent === 'D'`), 'and the card carries their name and initial');
  // how often, from the rhythm on the card
  await clickIn(keeper, 'Sweep the porch', '.rhythm');
  await choose(keeper, 'monthly');
  expect(await untilRows('the rhythm', '_fdata/chores', (r) => r.find((x) => x.cells.chore === 'Sweep the porch' && x.cells.cadence === 'monthly')), 'a chore\'s rhythm is changed');
  expect(await keeper.until('the monthly card', `${card('Sweep the porch')}.querySelector('.rhythm').textContent === 'monthly' && ${card('Sweep the porch')}.querySelectorAll('.slot').length === 4`), 'and a monthly card holds four holes');
  await keeper.shot('4-changed');

  // a stranger at the published address watches, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the chart for a stranger', `document.querySelectorAll('.card').length === 6`)) return;
  expect(await visitor.inFrame(`return ${main}.classList.contains('read-only') && document.querySelector('.banner')?.textContent.trim() === 'You are watching this chart.'`), 'a stranger is told the chart is theirs to watch');
  expect(await visitor.inFrame(`return !document.querySelector('.add') && [...document.querySelectorAll('.slot, .who, .rhythm, .c-name')].every((b) => b.disabled)`), 'and has no strip and nothing to press');
  expect(await visitor.inFrame(`return document.querySelector('.progress span').textContent === '3 of 6 done' && ${card('Bins')}.classList.contains('done') && !${card('Feed the cat')}.classList.contains('done')`), 'the stranger sees the chart as it stands');
  await visitor.shot('5-stranger');
  await pick(visitor, 'Feed the cat', '.slot.live');
  await visitor.click('[data-pick]');
  await sleep(400);
  expect((await rows('_fdata/chores')).find((x) => x.id === 'yday')?.cells.last_done_ms === 0, "a stranger's press changes nothing");

  // nobody touches the stranger's page: the push says to read again
  await clickIn(keeper, 'Feed the cat', '.slot.live');
  expect(await untilRows('the punch again', '_fdata/chores', (r) => r.find((x) => x.id === 'yday' && x.cells.last_done_ms > 0)), 'the keeper punches it again');
  expect(await visitor.until('it to reach the stranger', `${card('Feed the cat')}?.classList.contains('done') && document.querySelector('.progress span').textContent === '4 of 6 done'`), "and the stranger's open page is told to read again");

  // remove asks first
  await clickIn(keeper, 'Hoover', '.c-name');
  await choose(keeper, 'Remove');
  if (!await keeper.until('the confirm', `/Remove "Hoover" from the chart\\?/.test(document.querySelector('.framelib-prompt-msg')?.textContent ?? '')`)) return;
  await keeper.shot('6-remove');
  await keeper.click('.framelib-btn-ghost');
  await sleep(400);
  expect((await rows('_fdata/chores')).some((x) => x.id === 'long') && await keeper.inFrame(`return !!${card('Hoover')}`), 'Cancel removes nothing');
  await clickIn(keeper, 'Hoover', '.c-name');
  await choose(keeper, 'Remove');
  await keeper.until('the confirm again', `!!document.querySelector('.framelib-btn-primary')`);
  await keeper.click('.framelib-btn-primary');
  expect(await untilRows('the removal', '_fdata/chores', (r) => r.length === 5 && !r.some((x) => x.id === 'long')), 'Remove takes the chore out');
  expect(await keeper.until('it to go', `document.querySelectorAll('.card').length === 5`), 'and it is gone from the board');
  expect(await visitor.until('it to go for the stranger', `document.querySelectorAll('.card').length === 5`), "and from the stranger's");
  await keeper.shot('7-after');
  await visitor.shot('8-stranger-after');
};
