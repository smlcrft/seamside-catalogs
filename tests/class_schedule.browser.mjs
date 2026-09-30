// Class Schedule in the viewer: the keeper draws, moves, renames and removes classes; a stranger reads along.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const today = (new Date().getDay() + 6) % 7;
  const root = `document.querySelector('main')`;
  const says = (re) => `${re}.test(${root}?.textContent ?? '')`;

  // The block of a class on a day, marked so a selector can name it; its box in the frame.
  const pick = (b, title, day, mark = 'pick') => b.inFrame(`
    document.querySelectorAll('[data-${mark}]').forEach((e) => e.removeAttribute('data-${mark}'));
    const el = [...document.querySelectorAll('.col[data-day="${day}"] .block')].find((x) => x.querySelector('.t')?.textContent === ${JSON.stringify(title)});
    if (!el) return null;
    el.setAttribute('data-${mark}', '');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };`);
  const hourPx = (b) => b.inFrame(`const c = document.querySelector('.col'); return c.getBoundingClientRect().height / c.querySelectorAll('.hourline:not(.half)').length;`);
  const colX = (b, day) => b.inFrame(`const r = document.querySelector('.col[data-day="${day}"]').getBoundingClientRect(); return r.left + r.width / 2;`);
  const drag = async (b, from, to) => {
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', buttons, clickCount: 1 }, b.child);
    await mouse('mousePressed', from, 1);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6 }, 1);
    await mouse('mouseReleased', to, 0);
    await sleep(400);
  };

  // ----- the empty week
  if (!await keeper.until('the page to draw', `!!document.querySelector('main .seg')`)) return;
  expect(await keeper.inFrame(`return ${says('/Nothing here yet\\. Open the week and drag/')} && !document.querySelector('.banner')`), 'the keeper is told how to start, with no read-only banner');
  expect(await keeper.inFrame(`return !document.querySelector('form') && getComputedStyle(${root}).display === 'flex' && !!document.querySelector('.toolbar .iconbtn')`), 'the page has its style, holds no form, and offers Add');
  await keeper.shot('1-empty');

  await keeper.click('.seg button:nth-child(2)');
  if (!await keeper.until('the week', `document.querySelectorAll('.col.drawable').length >= 5`)) return;
  expect(await keeper.inFrame(`return /drag to block time/.test(document.querySelector('.toolbar').textContent)`), 'the week says it takes a drag');

  // ----- draw a class on Monday, 9:30 to 10:30 (an empty week shows from 8), and repeat it Wednesday
  let px = await hourPx(keeper);
  const monTop = await keeper.inFrame(`return document.querySelector('.col[data-day="0"]').getBoundingClientRect().top;`);
  const monX = await colX(keeper, 0);
  await drag(keeper, { x: monX, y: monTop + 1.5 * px }, { x: monX, y: monTop + 2.5 * px });
  if (!await keeper.until('the new block to ask its name', `document.activeElement === document.querySelector('.naming-new input')`)) return;
  await keeper.shot('2-drawn');
  await keeper.click('.naming-new .days-mini button:nth-child(3)');
  expect(await keeper.inFrame(`return document.querySelector('.naming-new .days-mini button:nth-child(3)').classList.contains('on') && document.activeElement === document.querySelector('.naming-new input')`), 'Wednesday is ticked and the name keeps the caret');
  await keeper.fill('.naming-new input', 'Maths');
  await keeper.press('Enter');
  const maths = await untilRows('the two meetings', 'class_schedule', (r) => {
    const m = r.filter((x) => x.cells.title === 'Maths');
    return m.length === 2 ? m : null;
  });
  expect(maths && maths.map((x) => x.cells.day).sort().join() === '0,2' && maths.every((x) => x.cells.start_min === 570 && x.cells.end_min === 630
    && x.cells.place === '' && x.cells.note === '' && x.cells._created_at && x.cells._modified_at), 'one row per meeting, 9:30 to 10:30, in the shape installed copies hold');
  expect(await keeper.until('both blocks', `document.querySelectorAll('.block').length === 2 && !document.querySelector('.naming-new')`), 'and both meetings are drawn');
  await sleep(300);
  expect((await rows('class_schedule')).length === 2, 'nothing is written twice');
  const mon = maths?.find((x) => x.cells.day === 0);

  // ----- move Monday's meeting an hour later, onto Tuesday
  px = await hourPx(keeper);
  let at = await pick(keeper, 'Maths', 0);
  const tueX = await colX(keeper, 1);
  await drag(keeper, { x: at.x, y: at.y }, { x: tueX, y: at.y + px });
  const moved = await untilRows('the move', 'class_schedule', (r) => r.find((x) => x.id === mon?.id && x.cells.day === 1));
  expect(moved?.cells.start_min === 630 && moved?.cells.end_min === 690 && moved?.cells._created_at === mon?.cells._created_at, 'a dragged block moves its meeting to the day and hour it was let go on, the row kept');
  expect(await keeper.until('it to draw on Tuesday', `!!document.querySelector('.col[data-day="1"] .block') && !document.querySelector('.col[data-day="0"] .block')`), 'and is drawn there');

  // ----- stretch it by its foot, half an hour
  px = await hourPx(keeper);
  at = await pick(keeper, 'Maths', 1);
  await drag(keeper, { x: at.x, y: at.bottom - 3 }, { x: at.x, y: at.bottom - 3 + px / 2 });
  expect(await untilRows('the stretch', 'class_schedule', (r) => r.find((x) => x.id === mon?.id && x.cells.start_min === 630 && x.cells.end_min === 720)), 'the foot of a block changes how long it runs');

  // ----- tap to rename; the class is renamed, and a Thursday meeting is ticked on
  at = await pick(keeper, 'Maths', 1);
  await drag(keeper, at, at);
  if (!await keeper.until('the rename box', `document.activeElement === document.querySelector('.block.renaming input')`)) return;
  await keeper.click('.block.renaming .days-mini button:nth-child(4)');
  await keeper.fill('.block.renaming input', 'Calculus');
  await keeper.shot('3-renaming');
  // committed by leaving the box: Enter there opens the box again (reported, not this move's)
  await keeper.click('.header h1');
  const calc = await untilRows('the rename', 'class_schedule', (r) => {
    const c = r.filter((x) => x.cells.title === 'Calculus');
    return c.length === 3 && !r.some((x) => x.cells.title === 'Maths') ? c : null;
  });
  const thu = calc?.find((x) => x.cells.day === 3);
  expect(calc && thu?.cells.start_min === 630 && thu?.cells.end_min === 720 && calc.find((x) => x.cells.day === 2)?.cells.start_min === 570,
    'renaming one meeting renames the class, and the ticked day is a new meeting in its slot');
  expect(await keeper.until('the new name everywhere', `[...document.querySelectorAll('.block .t')].map((t) => t.textContent).join() === 'Calculus,Calculus,Calculus'`), 'and every block says it');
  await keeper.shot('4-week');

  // ----- details: the place, written from the sheet
  at = await pick(keeper, 'Calculus', 2);
  await drag(keeper, at, at);
  if (!await keeper.until('the rename box', `!!document.querySelector('.block.renaming .more')`)) return;
  await keeper.click('.block.renaming .more');
  if (!await keeper.until('the sheet', `document.querySelector('.sheet h2')?.textContent === 'Edit class'`)) return;
  await keeper.fill('.sheet input[placeholder="Room 2.04"]', 'Room 9');
  await keeper.shot('5-sheet');
  await keeper.click('.sheet .btn-primary');
  const wed = await untilRows('the place', 'class_schedule', (r) => r.find((x) => x.cells.day === 2 && x.cells.place === 'Room 9'));
  expect(wed?.cells.start_min === 570 && wed?.cells.end_min === 630 && wed?.cells.title === 'Calculus', 'save writes the place and keeps the times the sheet showed');
  expect(await keeper.until('the sheet to close', `!document.querySelector('.sheet')`), 'and the sheet closes');

  // ----- remove just Thursday's meeting, asked which
  at = await pick(keeper, 'Calculus', 3);
  await drag(keeper, at, at);
  await keeper.until('the rename box', `!!document.querySelector('.block.renaming .more')`);
  await keeper.click('.block.renaming .more');
  await keeper.until('the sheet', `!!document.querySelector('.sheet')`);
  await keeper.click('.sheet-foot .btn-quiet');
  if (!await keeper.until('the question', `document.querySelectorAll('.framelib-choose-opt').length === 2`)) return;
  await keeper.shot('6-choose');
  await keeper.click('.framelib-choose-opt');
  expect(await untilRows('the one removed', 'class_schedule', (r) => r.length === 2 && !r.some((x) => x.id === thu?.id)), 'Just this meeting removes that one meeting');

  // ----- Add: today, named in place
  await keeper.click('.toolbar .iconbtn');
  if (!await keeper.until('the new block', `document.activeElement === document.querySelector('.naming-new input')`)) return;
  await keeper.fill('.naming-new input', 'Study');
  await keeper.press('Enter');
  const study = await untilRows('the class added', 'class_schedule', (r) => r.find((x) => x.cells.title === 'Study'));
  expect(study?.cells.day === today && study?.cells.end_min - study?.cells.start_min === 60, 'Add makes an hour today');
  await keeper.click('.seg button:nth-child(1)');
  expect(await keeper.until('today', `[...document.querySelectorAll('.agenda .ag .nm')].some((n) => n.textContent === 'Study') && !!document.querySelector('.countdown .big')`), 'and today lists it under the countdown');
  await keeper.shot('7-today');

  // ----- a stranger at the published address reads, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the page for a stranger', `!!document.querySelector('main .seg')`)) return;
  expect(await visitor.inFrame(`return ${root}.classList.contains('read-only') && /You are looking at this timetable\\./.test(document.querySelector('.banner')?.textContent ?? '') && !document.querySelector('.toolbar .iconbtn')`), 'a stranger is told the timetable is theirs to look at, with no Add');
  await visitor.click('.seg button:nth-child(2)');
  if (!await visitor.until('the week for a stranger', `document.querySelectorAll('.block').length === 3`)) return;
  expect(await visitor.inFrame(`return !document.querySelector('.col.drawable') && !document.querySelector('.grip') && [...document.querySelectorAll('.col[data-day="2"] .block')].some((b) => /Room 9/.test(b.title))`), 'and sees the week as it stands, with nothing to grab');
  await visitor.shot('8-stranger');
  const vat = await pick(visitor, 'Calculus', 1);
  await drag(visitor, vat, { x: vat.x, y: vat.y + 60 });
  await drag(visitor, vat, vat);
  expect(await visitor.inFrame(`return !document.querySelector('.block.renaming') && !document.querySelector('.naming-new')`), "a stranger's drag and tap open nothing");
  expect((await rows('class_schedule')).find((x) => x.id === mon?.id)?.cells.start_min === 630, 'and change nothing');

  // ----- remove every meeting of a class; the stranger's page is told to read again
  await keeper.click('.seg button:nth-child(2)');
  await keeper.until('the week', `document.querySelectorAll('.block').length === 3`);
  at = await pick(keeper, 'Calculus', 1);
  await drag(keeper, at, at);
  await keeper.until('the rename box', `!!document.querySelector('.block.renaming .more')`);
  await keeper.click('.block.renaming .more');
  await keeper.until('the sheet', `!!document.querySelector('.sheet')`);
  await keeper.click('.sheet-foot .btn-quiet');
  await keeper.until('the question', `document.querySelectorAll('.framelib-choose-opt').length === 2`);
  await keeper.click('.framelib-choose-opt:nth-child(2)');
  expect(await untilRows('the class removed', 'class_schedule', (r) => r.length === 1 && r[0].cells.title === 'Study'), 'Every meeting removes the class');
  expect(await visitor.until('the stranger to follow', `document.querySelectorAll('.block').length === 1`), "and the stranger's open page follows");

  // ----- turning off every day of a class asks, then removes it
  at = await pick(keeper, 'Study', today);
  await drag(keeper, at, at);
  if (!await keeper.until('the rename box', `!!document.querySelector('.block.renaming .days-mini')`)) return;
  await keeper.click(`.block.renaming .days-mini button:nth-child(${today + 1})`);
  await keeper.click('.header h1');
  if (!await keeper.until('the question', `!!document.querySelector('.framelib-btn-primary')`)) return;
  await sleep(300);
  expect((await rows('class_schedule')).length === 1, 'nothing goes before the answer');
  await keeper.click('.framelib-btn-primary');
  expect(await untilRows('the last removed', 'class_schedule', (r) => r.length === 0), 'Remove takes the class out');
  await keeper.click('.seg button:nth-child(1)');
  expect(await keeper.until('the empty day', says('/Nothing here yet/')), 'and the keeper is back to an empty timetable');
  expect(await visitor.until('the stranger to see it empty', `document.querySelectorAll('.block').length === 0`), 'as is the stranger');
  await keeper.shot('9-after');
  await visitor.shot('10-stranger-after');
};
