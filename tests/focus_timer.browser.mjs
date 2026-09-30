// Focus Timer in the viewer: the keeper turns the dial, names the session and runs it; a
// stranger at the published address watches the same countdown and drives nothing.

export default async ({ keeper, visitor: open, expect, sleep }) => {
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '').trim()`;
  // What the worker keeps for this session, read through its own route: the daemon's copy, not the page's.
  const kept = async () => JSON.parse(await keeper.inFrame(`const r = await window.seamside.fetch('/api/state'); return JSON.stringify((await r.json()).session ?? null);`) ?? 'null');
  const untilKept = async (what, test) => {
    for (let i = 0; i < 40; i++) { const v = await kept(); if (v && test(v)) return v; await sleep(250); }
    expect(false, `the session kept ${what}`);
    return null;
  };
  const readout = (b) => b.inFrame(`return ${text('.time')} + ' ' + ${text('.state')};`);

  if (!await keeper.until('the dial to draw', `${text('.time')} === '25:00'`)) return;
  expect(await readout(keeper) === '25:00 ready' && await keeper.inFrame(`return ${text('.header .mode')} === 'owner' && !!document.querySelector('.knob') && !document.querySelector('.banner')`), 'the keeper is shown a ready dial at twenty-five minutes, a knob to turn and no banner');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.controls')).display === 'flex' && document.styleSheets.length >= 2`), 'the page has its style');
  await keeper.shot('1-ready');

  // ----- turning the dial: three o'clock is fifteen minutes
  const dial = await keeper.inFrame(`const r = document.querySelector('.dial').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };`);
  const mouse = (type, x, y, buttons) => keeper.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1 }, keeper.child);
  await mouse('mousePressed', dial.x + dial.r * 0.7 * Math.sin(Math.PI / 6), dial.y - dial.r * 0.7 * Math.cos(Math.PI / 6), 1);
  for (let i = 1; i <= 6; i++) {
    const a = Math.PI / 6 + (Math.PI / 2 - Math.PI / 6) * i / 6;
    await mouse('mouseMoved', dial.x + dial.r * 0.7 * Math.sin(a), dial.y - dial.r * 0.7 * Math.cos(a), 1);
  }
  expect(await keeper.until('the ring to follow the hand', `${text('.time')} === '15:00' && ${text('.state')} === 'set'`), 'while turning, the readout follows the hand');
  await mouse('mouseReleased', dial.x + dial.r * 0.7, dial.y, 0);
  expect(await untilKept('fifteen minutes', (v) => v.duration_s === 900 && v.label === '' && v.ends_at_ms === 0), 'a turn of the dial is kept as the session length on release');
  expect(await keeper.until('the dial to settle', `${text('.time')} === '15:00' && ${text('.state')} === 'ready'`), 'and the dial reads it');

  // ----- an arrow key nudges a minute
  await keeper.inFrame(`document.querySelector('.dial').focus(); return true;`);
  await keeper.press('ArrowUp', 38);
  expect(await untilKept('sixteen minutes', (v) => v.duration_s === 960), 'ArrowUp adds a minute');
  expect(await keeper.until('the readout', `${text('.time')} === '16:00'`), 'and the dial shows it');

  // ----- what it is for
  await keeper.fill('.label-row input', 'Chapter three');
  await keeper.press('Enter');
  expect(await untilKept('the label', (v) => v.label === 'Chapter three' && v.duration_s === 960), 'Enter keeps what it is for, over the rest of the timer');
  await keeper.shot('2-set');

  // ----- a stranger watches
  const visitor = await open();
  if (!await visitor.until('the dial to draw', `${text('.time')} === '16:00'`)) return;
  expect(await visitor.inFrame(`return ${text('.banner')} === 'You are watching this timer.' && ${text('.header .mode')} === 'viewer' && ${text('.label-static')} === 'Chapter three'`), 'a stranger is told they are watching, and shown what it is for');
  expect(await visitor.inFrame(`return !document.querySelector('.controls') && !document.querySelector('.knob') && !document.querySelector('.label-row input')`), 'and is given nothing to drive it with');
  await visitor.shot('3-stranger-ready');

  // ----- start, and the stranger's page follows by itself
  await keeper.click('.controls .btn-primary');
  const running = await untilKept('a deadline', (v) => v.ends_at_ms > Date.now() && v.started_by === 'the owner');
  expect(running && running.ends_at_ms - Date.now() <= 960_000, 'start keeps the moment it ends, named as the owner');
  expect(await keeper.until('the keeper to see it run', `${text('.state')} === 'focusing' && ${text('.by')} === 'the owner started this' && /pause/.test(${text('.controls')})`), 'the keeper sees it focusing, with pause and reset');
  expect(await visitor.until('the countdown to reach the stranger', `${text('.state')} === 'focusing' && /^15:[0-5][0-9]$/.test(${text('.time')})`), "the stranger's open page is told, and counts down");
  const t1 = await visitor.inFrame(`return ${text('.time')};`);
  await sleep(2200);
  expect(await visitor.inFrame(`return ${text('.time')};`) !== t1, 'the stranger watches the seconds go by');
  expect(await visitor.inFrame(`return ${text('.by')} === 'the owner started this'`), 'and who started it');
  await keeper.shot('4-running');
  await visitor.shot('5-stranger-running');

  // ----- pause, resume, reset
  await keeper.click('.controls .btn-primary');
  const paused = await untilKept('the seconds left', (v) => v.ends_at_ms === 0 && v.paused_left_s > 0);
  expect(paused && paused.paused_left_s <= 960, 'pause keeps whole seconds rather than a deadline');
  expect(await keeper.until('resume', `${text('.state')} === 'paused' && /resume/.test(${text('.controls')})`), 'the keeper sees it paused, with resume');
  expect(await visitor.until('the pause to reach the stranger', `${text('.state')} === 'paused'`), 'and so does the stranger');
  const held = await visitor.inFrame(`return ${text('.time')};`);
  await sleep(1500);
  expect(await visitor.inFrame(`return ${text('.time')};`) === held, 'a paused timer does not move');
  await keeper.shot('6-paused');
  await keeper.click('.controls .btn-quiet');
  expect(await untilKept('the reset', (v) => v.ends_at_ms === 0 && v.paused_left_s === 0 && v.started_by === '' && v.duration_s === 960 && v.label === 'Chapter three'), 'reset goes back to the top of the dial and keeps its length and label');
  expect(await keeper.until('ready again', `${text('.time')} === '16:00' && ${text('.state')} === 'ready' && !document.querySelector('.controls .btn-quiet')`), 'the keeper sees it ready again');
  expect(await visitor.until('ready for the stranger', `${text('.time')} === '16:00' && ${text('.state')} === 'ready'`), 'and so does the stranger');
};
