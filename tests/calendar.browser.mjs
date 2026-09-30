// Calendar in the viewer: the keeper adds, changes and deletes events; a stranger reads along.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '')`;
  const chips = `[...document.querySelectorAll('.cell.today .chip .lbl')].map((c) => c.textContent)`;
  const modalOpen = `!!document.querySelector('.form input[type=text]')`;
  const primary = `.framelib-modal .fb-btn.primary, .fb-btn.primary`;
  const now = new Date();
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (!await keeper.until('the month to draw', `!!document.querySelector('.weeks .cell.today')`)) return;
  expect(await keeper.inFrame(`return ${text('.topbar .title')}.startsWith(${JSON.stringify(MONTHS[now.getMonth()])})`), 'the keeper is shown this month');
  expect(await keeper.inFrame(`return !!document.querySelector('.tbtn.primary') && !!document.querySelector('.cell.editable')`), 'with the Add button, and days that take a click');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.weeks')).display === 'grid' && !document.querySelector('form')`), 'the page has its style and holds no form');
  await keeper.shot('1-empty');

  // a new event: Add with nothing written adds nothing, then by the button
  await keeper.click('.tbtn.primary');
  if (!await keeper.until('the editor', modalOpen)) return;
  expect(await keeper.inFrame(`return document.querySelector('.form input[type=date]').value === ${JSON.stringify(todayIso)}`), 'a new event starts today');
  await keeper.press('Enter');
  await sleep(400);
  expect((await rows('_fdata/calendar')).length === 0 && await keeper.inFrame(`return ${modalOpen}`), 'Enter with no title adds nothing');
  await keeper.fill('.form input[type=text]', 'Market day');
  // a time control takes no typed text here; set it as the picker would
  await keeper.inFrame(`const t = document.querySelector('.form input[type=time]'); t.value = '09:30'; t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(200);
  await keeper.inFrame(`const s = document.querySelector('.form select'); s.value = '60'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await keeper.click('.swatch:nth-child(4)');
  await keeper.fill('.form input[type=url]', 'https://example.com/market');
  await keeper.fill('.form textarea', 'Bring bags');
  await keeper.shot('2-editor');
  await keeper.click(primary);
  const market = await untilRows('the event', '_fdata/calendar', (r) => r.find((x) => x.cells.title === 'Market day'));
  expect(market?.cells.date === todayIso && market?.cells.time === '09:30' && market?.cells.dur === 60 && market?.cells.color === 'c3'
    && market?.cells.url === 'https://example.com/market' && market?.cells.note === 'Bring bags' && market?.cells.recur === null
    && market?.cells.tz && market?.cells._created_at && market?.cells._modified_at, 'an event added is a row of the space, stamped, with its zone');
  expect(await keeper.until('the chip to draw', `${chips}.includes('Market day') && !(${modalOpen})`), 'and drawn on today, the editor closed');

  // a weekly one, added by Enter
  await keeper.click('.tbtn.primary');
  await keeper.until('the editor again', modalOpen);
  await keeper.click('.seg button:nth-child(2)');
  await keeper.until('the days', `!!document.querySelector('.dpill')`);
  await keeper.inFrame(`document.querySelectorAll('.dpill')[${now.getDay()}].setAttribute('data-today', ''); return true;`);
  await keeper.click('.dpill[data-today]');
  await keeper.click('.ends .toggle input');
  await keeper.fill('.form input[type=text]', 'Standup');
  await keeper.press('Enter');
  const standup = await untilRows('the series', '_fdata/calendar', (r) => r.find((x) => x.cells.title === 'Standup'));
  const r = standup?.cells.recur;
  expect(standup?.cells.date === '' && JSON.stringify(r?.days) === JSON.stringify([now.getDay()]) && r?.start === todayIso && r?.until === '' && r?.skip?.length === 0, 'a weekly event is kept as a series, forever, from today');
  expect(await keeper.until('both to draw', `${chips}.includes('Standup') && ${chips}.includes('Market day')`), 'and drawn beside the first');
  await keeper.shot('3-two');

  // the link opens through the viewer; stand in for the tab it would open
  await keeper.evaluate(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; return true;`);
  await keeper.inFrame(`[...document.querySelectorAll('.cell.today .chip')].find((c) => /Market day/.test(c.textContent)).setAttribute('data-pick', ''); return true;`);
  await keeper.click('.chip[data-pick]');
  if (!await keeper.until('the event to open', `document.querySelector('.form input[type=text]')?.value === 'Market day'`)) return;
  await keeper.click('.urlrow .iconbtn');
  expect(await keeper.evaluate(`return JSON.stringify(window.__opened)`) === JSON.stringify(['https://example.com/market']), 'Open link hands the link to the viewer');

  // a change lands over the row it was
  await keeper.clear('.form input[type=text]');
  await keeper.fill('.form input[type=text]', 'Market morning');
  await keeper.click(primary);
  const changed = await untilRows('the change', '_fdata/calendar', (r) => r.find((x) => x.id === market?.id && x.cells.title === 'Market morning'));
  expect(changed?.cells._created_at === market?.cells._created_at && changed?.cells.note === 'Bring bags' && (await rows('_fdata/calendar')).length === 2, 'a change keeps the row, its birth and the rest of it');
  expect(await keeper.until('the new name', `${chips}.includes('Market morning')`), 'and is drawn');

  // the week view
  await keeper.click('.vtoggle button:nth-child(2)');
  expect(await keeper.until('the week', `!!document.querySelector('.wk-grid .wk-ev') && /Market morning/.test(document.querySelector('.wk-grid').textContent) && /Standup/.test(document.querySelector('.wk-allday').textContent)`), 'the week lays the timed event by the hour and the series all day');
  await keeper.shot('4-week');

  // a stranger at the published address reads, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the calendar for a stranger', `!!document.querySelector('.topbar')`)) return;
  expect(await visitor.until('the events', `/Market morning/.test(document.body.textContent) && /Standup/.test(document.body.textContent)`), 'a stranger is shown the events');
  expect(await visitor.inFrame(`return !document.querySelector('.tbtn.primary') && !document.querySelector('.editable')`), 'and no Add, and no day that takes a click');
  await visitor.inFrame(`[...document.querySelectorAll('.chip, .wk-ev')].find((c) => /Market morning/.test(c.textContent)).setAttribute('data-pick', ''); return true;`);
  await visitor.click('[data-pick]');
  expect(await visitor.until('the peek', `/Bring bags/.test(document.body.textContent) && !document.querySelector('.form input[type=text]')`), 'an event opens to be read, not changed');
  await visitor.shot('5-stranger-peek');
  await visitor.click('.fb-btn:not(.primary)');

  // nobody touches the stranger's page: a push says to read again
  await seed('_fdata/calendar', 'seeded0001', { title: 'Open house', date: todayIso, time: '', tz: '', dur: 0, color: '', url: '', note: '', recur: null, _created_at: 1, _modified_at: 1 });
  await keeper.click('.vtoggle button:nth-child(1)');
  await keeper.click('.cell.today .cell-head');
  await keeper.until('an editor for today', modalOpen);
  await keeper.fill('.form input[type=text]', 'Picnic');
  await keeper.click(primary);
  await untilRows('the picnic', '_fdata/calendar', (r) => r.find((x) => x.cells.title === 'Picnic'));
  expect(await visitor.until('the picnic to reach the stranger', `/Picnic/.test(document.body.textContent)`), "the stranger's open page reads again when told");

  // deleting: a one-time event goes outright, a series asks which days
  await keeper.inFrame(`[...document.querySelectorAll('.cell.today .chip')].find((c) => /Picnic/.test(c.textContent)).setAttribute('data-pick', ''); return true;`);
  await keeper.click('.chip[data-pick]');
  await keeper.until('the editor for the picnic', `document.querySelector('.form input[type=text]')?.value === 'Picnic'`);
  await keeper.click('.fb-btn.danger');
  expect(await untilRows('the picnic to go', '_fdata/calendar', (r) => !r.some((x) => x.cells.title === 'Picnic')), 'Delete removes a one-time event');
  await keeper.inFrame(`[...document.querySelectorAll('.cell.today .chip')].find((c) => /Standup/.test(c.textContent)).setAttribute('data-pick', ''); return true;`);
  await keeper.click('.chip[data-pick]');
  await keeper.until('the editor for the series', `document.querySelector('.form input[type=text]')?.value === 'Standup'`);
  await keeper.click('.fb-btn.danger');
  if (!await keeper.until('the question', `!!document.querySelector('.delsheet')`)) return;
  await keeper.shot('6-delete-series');
  await keeper.click('.delopt:nth-of-type(1)');
  const skipped = await untilRows('the day to be skipped', '_fdata/calendar', (r) => r.find((x) => x.id === standup?.id && x.cells.recur?.skip?.includes(todayIso)));
  expect(skipped?.cells.recur?.days?.length === 1 && skipped?.cells.recur?.until === '', 'Only this day skips today and keeps the series');
  expect(await keeper.until('today to lose it', `!${chips}.includes('Standup') && ${chips}.includes('Open house')`), 'and today no longer shows it');
  expect(await visitor.until('the stranger to follow', `!/Standup/.test(document.querySelector('.cell.today')?.textContent ?? '') && /Open house/.test(document.body.textContent)`), 'nor does the stranger\'s');
  await keeper.shot('7-after');
  await visitor.shot('8-stranger-after');
};
