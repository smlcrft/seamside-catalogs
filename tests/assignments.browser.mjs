// Assignments in the viewer: the keeper adds courses and work, sizes and dates it, scores
// it, ticks it off and removes it; a stranger at the published address sees the same board
// live and has nothing to change.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = `(document.getElementById('app')?.textContent ?? '')`;
  const titles = `[...document.querySelectorAll('.w .w-title')].map((e) => e.textContent)`;
  const verdict = `(document.querySelector('.verdict')?.textContent ?? '')`;
  const p = (n) => String(n).padStart(2, '0');
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  // Mark one element of the row whose title matches, so a selector can name it.
  const mark = (b, title, inner) => b.inFrame(`
    document.querySelectorAll('[data-t]').forEach((e) => e.removeAttribute('data-t'));
    const r = [...document.querySelectorAll('.w')].find((x) => x.querySelector('.w-title')?.textContent === ${JSON.stringify(title)});
    const el = r?.querySelector(${JSON.stringify(inner)});
    if (el) el.setAttribute('data-t', '1');
    return !!el;`);
  const pick = async (b, label) => {
    if (!await b.until('the choices', `document.querySelectorAll('.framelib-choose-opt').length > 0`)) return;
    await b.inFrame(`
      const o = [...document.querySelectorAll('.framelib-choose-opt')].find((e) => e.textContent.includes(${JSON.stringify(label)}));
      if (o) o.setAttribute('data-t', 'opt');
      return !!o;`);
    await b.click('[data-t="opt"]');
  };
  const answer = async (b, words) => {
    if (!await b.until('the question', `!!document.querySelector('.framelib-prompt-input')`)) return;
    await b.clear('.framelib-prompt-input');
    if (words) await b.fill('.framelib-prompt-input', words);
    await b.click('.framelib-dialog-host .framelib-btn-primary');
    await sleep(200);
  };
  const ok = async (b) => {
    if (!await b.until('the confirmation', `!!document.querySelector('.framelib-dialog-host .framelib-btn-primary')`)) return;
    await b.click('.framelib-dialog-host .framelib-btn-primary');
  };
  const quick = async (b, label) => {
    if (!await b.until('the calendar', `!!document.querySelector('.dp')`)) return;
    await b.inFrame(`[...document.querySelectorAll('.dp-quick button')].find((e) => e.textContent === ${JSON.stringify(label)}).setAttribute('data-t', 'q'); return true;`);
    await b.click('[data-t="q"]');
  };

  if (!await keeper.until('the page to draw', `!!document.querySelector('main .header')`)) return;
  expect(await keeper.until('an empty board', `/Add a course to start — the \\+ is up in the corner\\./.test(${text})`), 'the keeper has an empty board and is told where to start');
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && !!document.querySelector('.header .iconbtn') && !document.querySelector('.banner') && !document.querySelector('form') && getComputedStyle(document.querySelector('main')).display === 'flex'`), 'the keeper is the owner with a + and no banner, and the page has its style');
  await keeper.shot('1-empty');

  const visitor = await open();
  if (!await visitor.until('the page to draw for a stranger', `/Nothing here yet\\./.test(${text})`)) return;
  expect(await visitor.inFrame(`return /You are looking at this board\\./.test(${text}) && !document.querySelector('.header .iconbtn') && document.querySelector('.header .mode').textContent === 'viewer' && document.querySelector('main').classList.contains('read-only')`), 'a stranger is looking, with no way to add');

  // two courses: one with its credits, one taking the three offered
  await keeper.click('.header .iconbtn');
  await answer(keeper, 'Biology');
  await answer(keeper, '4');
  const bio = await untilRows('the course', 'assignments_courses', (r) => r.find((x) => x.cells.name === 'Biology'));
  expect(bio?.cells.credits === 4 && bio?.cells.sort_order === 0 && bio?.cells._created_at > 0 && bio?.cells._modified_at > 0, 'a course is a row of the space, with its credits');
  expect(await keeper.until('the board', `/Nothing outstanding\\./.test(${verdict}) && !!document.querySelector('.add .f-title')`), 'and the board opens with nothing outstanding and the add strip');
  expect(await visitor.until('the course to reach the stranger', `/Nothing outstanding\\./.test(${verdict})`), "the stranger's open page is told to read again");
  await keeper.click('.header .iconbtn');
  await answer(keeper, 'History');
  await answer(keeper, '');
  const hist = await untilRows('the second course', 'assignments_courses', (r) => r.find((x) => x.cells.name === 'History'));
  expect(hist?.cells.credits === 3 && hist?.cells.sort_order === 1, 'a course given no credits is worth three, and goes after');
  expect(await keeper.until('both in the picker', `[...document.querySelectorAll('.add .f-course option')].map((o) => o.textContent).join('|') === 'Biology|History'`), 'the add strip offers both courses in order');

  // a huge job due tomorrow, by Enter
  await keeper.inFrame(`[...document.querySelectorAll('.add .szbtn')][0].setAttribute('data-t', 'size'); [...document.querySelectorAll('.add .szbtn')][1].setAttribute('data-t', 'due'); return true;`);
  await keeper.click('[data-t="size"]');
  expect(await keeper.until('the size to cycle', `document.querySelector('[data-t="size"]').textContent.trim() === 'huge'`), 'the size switch cycles from doable to huge');
  await keeper.click('[data-t="due"]');
  await quick(keeper, 'tomorrow');
  expect(await keeper.until('the date to show', `!document.querySelector('.dp') && document.querySelector('[data-t="due"]').textContent.trim() === 'tomorrow'`), 'the calendar sets the date and closes');
  await keeper.fill('.add .f-title', 'Lab report');
  await keeper.press('Enter');
  const lab = await untilRows('the work', 'assignments', (r) => r.find((x) => x.cells.title === 'Lab report'));
  expect(lab?.cells.course_id === bio?.id && lab?.cells.due === day(1) && lab?.cells.size === 3 && lab?.cells.weight === 0 && lab?.cells.earned === -1 && lab?.cells.possible === 100 && lab?.cells.done === 0 && lab?.cells.added_ms > 0 && lab?.cells._created_at > 0, 'Enter adds the work to the first course, huge and due tomorrow, unmarked');
  expect(await keeper.until('the verdict', `${verdict} === 'Start with Lab report.' && !!document.querySelector('.w.s3.lead') && document.querySelector('.add .f-title').value === ''`), 'the page names it as the thing to start, drawn big, and the box is cleared');
  expect(await keeper.inFrame(`return /start now/.test(${text}) && /tomorrow/.test(document.querySelector('.w .dp-trigger').textContent)`), 'under start now, due tomorrow');
  expect(await visitor.until('the work to reach the stranger', `${verdict} === 'Start with Lab report.'`), 'and the stranger sees it');

  // a tiny job for the other course, with no date
  await keeper.inFrame(`const s = document.querySelector('.add .f-course'); s.value = ${JSON.stringify(hist?.id)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await keeper.click('[data-t="size"]');
  await keeper.click('[data-t="due"]');
  await quick(keeper, 'no date');
  expect(await keeper.until('the draft', `document.querySelector('[data-t="size"]').textContent.trim() === 'tiny' && document.querySelector('[data-t="due"]').textContent.trim() === 'no date'`), 'the size cycles on to tiny, and the date is cleared');
  await keeper.fill('.add .f-title', 'Reading');
  await keeper.press('Enter');
  const reading = await untilRows('the second work', 'assignments', (r) => r.find((x) => x.cells.title === 'Reading'));
  expect(reading?.cells.course_id === hist?.id && reading?.cells.due === '' && reading?.cells.size === 1, 'it lands in the chosen course, tiny and undated');
  expect(await keeper.until('the second row', `${titles}.join('|') === 'Lab report|Reading' && /no date/.test(${text}) && !!document.querySelector('.w.s1')`), 'and is drawn small, under no date');
  await keeper.shot('2-work');

  // a weight and a score, through the row's menu
  await mark(keeper, 'Lab report', '.w-title');
  await keeper.click('[data-t]');
  await pick(keeper, 'Weight of the course grade');
  await answer(keeper, '30');
  expect(await untilRows('the weight', 'assignments', (r) => r.find((x) => x.id === lab?.id && x.cells.weight === 30)), 'a weight is kept on the row');
  await mark(keeper, 'Lab report', '.w-title');
  await keeper.click('[data-t]');
  await pick(keeper, 'Enter a score');
  await answer(keeper, '90');
  const scored = await untilRows('the score', 'assignments', (r) => r.find((x) => x.id === lab?.id && x.cells.earned === 90));
  expect(scored?.cells.done === 1 && scored?.cells.weight === 30 && scored?.cells.due === lab?.cells.due && scored?.cells._created_at === lab?.cells._created_at, 'a score marks it finished, over what the row held');
  expect(await keeper.until('the score to show', `/finished/.test(${text}) && document.querySelector('.w.done .score')?.textContent === '90%' && document.querySelector('.gpa b')?.textContent === '3.70'`), 'it moves to finished with its score, and the GPA is drawn');

  await keeper.inFrame(`document.querySelectorAll('.seg button')[1].setAttribute('data-t', 'grades'); return true;`);
  await keeper.click('[data-t="grades"]');
  expect(await keeper.until('the grades', `document.querySelectorAll('.cc').length === 2`), 'the grades tab has a card per course');
  expect(await keeper.inFrame(`const c = document.querySelectorAll('.cc'); return c[0].querySelector('.n').textContent === '90%' && c[0].querySelector('.unit').textContent === 'A- · 4 cr' && /30% of the grade marked · 30% assigned/.test(c[0].textContent) && c[1].querySelector('.n').textContent === '—' && /nothing marked yet/.test(c[1].textContent)`), 'Biology is graded from what was marked, History has nothing marked');
  expect(await visitor.until('the stranger to follow', `document.querySelector('.gpa b')?.textContent === '3.70'`), 'the stranger sees the GPA');
  await keeper.shot('3-grades');

  // a course's credits, from its card
  await keeper.inFrame(`document.querySelectorAll('.cc-name')[1].setAttribute('data-t', 'hist'); return true;`);
  await keeper.click('[data-t="hist"]');
  await pick(keeper, 'Credits');
  await answer(keeper, '2');
  expect(await untilRows('the credits', 'assignments_courses', (r) => r.find((x) => x.id === hist?.id && x.cells.credits === 2 && x.cells.name === 'History' && x.cells.sort_order === 1)), 'a course takes new credits, the rest of it kept');
  expect(await keeper.until('the card to follow', `document.querySelectorAll('.cc .unit')[1]?.textContent === '2 cr'`), 'and its card says so');
  await keeper.inFrame(`document.querySelectorAll('.seg button')[0].setAttribute('data-t', 'due'); return true;`);
  await keeper.click('[data-t="due"]');

  // a tick lifts the row out; a second puts it back
  await mark(keeper, 'Reading', '.tick');
  await keeper.click('[data-t]');
  expect(await untilRows('the tick', 'assignments', (r) => r.find((x) => x.id === reading?.id && x.cells.done === 1)), 'a tick finishes the work');
  expect(await keeper.until('the row to move', `${verdict} === 'Nothing outstanding.' && document.querySelectorAll('.w.done').length === 2`), 'and it lifts into finished');
  await mark(keeper, 'Reading', '.tick');
  await keeper.click('[data-t]');
  expect(await untilRows('the untick', 'assignments', (r) => r.find((x) => x.id === reading?.id && x.cells.done === 0 && x.cells.size === 1)), 'a second tick puts it back');

  // a date from the row itself
  await keeper.until('the row back', `document.querySelectorAll('.w.done').length === 1`);
  await mark(keeper, 'Reading', '.dp-trigger');
  await keeper.click('[data-t]');
  await quick(keeper, 'next week');
  expect(await untilRows('the date', 'assignments', (r) => r.find((x) => x.id === reading?.id && x.cells.due === day(7))), "a row's date is set from its calendar");
  expect(await keeper.until('the date to draw', `/later/.test(${text})`), 'and a tiny thing a week out is later');

  // a stranger's page offers nothing to press, and a press changes nothing
  expect(await visitor.until('the board for the stranger', `${titles}.join('|') === 'Reading|Lab report'`), 'the stranger sees the work as it stands');
  expect(await visitor.inFrame(`return !document.querySelector('.add') && [...document.querySelectorAll('.tick, .w-title, .dp-trigger')].every((b) => b.disabled)`), 'with no add strip and nothing to press');
  await visitor.shot('4-stranger');
  await mark(visitor, 'Reading', '.tick');
  await visitor.inFrame(`document.querySelector('[data-t]').disabled = false; document.querySelector('[data-t]').click(); return true;`);
  await sleep(600);
  expect((await rows('assignments')).find((x) => x.id === reading?.id)?.cells.done === 0, "a stranger's press changes nothing");

  // a rename and a removal, through the menu
  await mark(keeper, 'Reading', '.w-title');
  await keeper.click('[data-t]');
  await pick(keeper, 'Rename');
  await answer(keeper, 'Chapter 4 reading');
  expect(await untilRows('the rename', 'assignments', (r) => r.find((x) => x.id === reading?.id && x.cells.title === 'Chapter 4 reading' && x.cells.due === day(7))), 'a rename lands over the row');
  expect(await visitor.until('the rename to reach the stranger', `${titles}.includes('Chapter 4 reading')`), 'and reaches the stranger');
  await mark(keeper, 'Chapter 4 reading', '.w-title');
  await keeper.click('[data-t]');
  await pick(keeper, 'Remove');
  await ok(keeper);
  expect(await untilRows('the removal', 'assignments', (r) => r.length === 1 && r[0].id === lab?.id), 'removing work deletes its row');
  expect(await keeper.until('it to go', `${titles}.join('|') === 'Lab report'`), 'and it is gone from the page');

  // work an installed copy left behind, read as it was
  await seed('assignments', 'old1', { course_id: hist?.id, title: 'Old essay', due: day(-2), weight: 50, size: 2, earned: -1, possible: 100, done: 0, added_ms: 5, _created_at: 5, _modified_at: 5 });
  await visitor.send('Page.reload');
  visitor.child = null;
  for (let i = 0; i < 60 && !visitor.child; i++) await sleep(250);
  expect(await visitor.until('the old work', `${titles}.includes('Old essay')`), 'work an installed copy left is read');
  expect(await visitor.inFrame(`return /1 overdue — start with Old essay\\./.test(${verdict}) && /2 days late/.test(${text}) && /50% of grade/.test(${text})`), 'overdue, two days late, and half the grade');
  await visitor.shot('5-stranger-overdue');

  // a course removed takes its work with it
  await keeper.inFrame(`document.querySelectorAll('.seg button')[1].setAttribute('data-t', 'grades'); return true;`);
  await keeper.click('[data-t="grades"]');
  await keeper.until('the grades', `document.querySelectorAll('.cc').length === 2`);
  await keeper.inFrame(`document.querySelectorAll('.cc-name')[1].setAttribute('data-t', 'hist'); return true;`);
  await keeper.click('[data-t="hist"]');
  await pick(keeper, 'Remove');
  await ok(keeper);
  expect(await untilRows('the course to go', 'assignments_courses', (r) => r.length === 1 && r[0].id === bio?.id), 'a course is removed');
  expect(await untilRows('its work to go', 'assignments', (r) => r.length === 1 && r[0].id === lab?.id), 'and its work with it');
  expect(await visitor.until('the stranger to follow', `!${titles}.includes('Old essay')`), "and the stranger's page follows");
  await keeper.shot('6-after');
};
