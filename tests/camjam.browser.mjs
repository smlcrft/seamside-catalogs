// CamJam in the viewer: the keeper names the feed, picks a rung and shares; a stranger watches.
// A headless browser has no camera, so the share is fed from a canvas standing in for
// getUserMedia: everything after the camera (capture, still, push, drawing) is the page's own.

const FAKE_CAMERA = `
  navigator.mediaDevices.getUserMedia = async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const paint = () => { g.fillStyle = 'hsl(' + Math.floor(Date.now() / 20) % 360 + ', 60%, 50%)'; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.fillRect(200, 140, 240, 200); };
    paint(); setInterval(paint, 100);
    return c.captureStream(10);
  };
  return true;`;

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const text = `document.querySelector('main')?.textContent ?? ''`;
  if (!await keeper.until('the feed to draw', `!!document.querySelector('main .stage')`)) return;
  expect(await keeper.evaluate(`return /camera/.test(document.querySelector('iframe')?.allow ?? '');`), 'the viewer seats the frame allowed the camera');
  expect(await keeper.until('the owner mode', `document.querySelector('.fh-mode')?.textContent === 'owner' && !!document.querySelector('.fh-gear')`), 'the keeper is the owner, with the settings');
  expect(await keeper.inFrame(`return /Nobody is sharing\\. Start a feed whenever you like\\./.test(${text}) && document.querySelector('.fh-title').value === 'My CamJam Feed'`), 'nobody is sharing, under the default title');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.stage')).borderRadius !== '0px' && !document.querySelector('form')`), 'the page has its style and no form');
  await keeper.shot('1-idle');

  // the title edits in place; Enter commits by leaving the field
  await keeper.clear('.fh-title');
  await keeper.fill('.fh-title', 'Workbench');
  await keeper.press('Enter');
  expect(await untilRows('the title', '__fc_settings', (r) => r.find((x) => x.id === 'camjam.title' && x.cells.v === '"Workbench"' && x.cells._created_at)), 'the title is kept where installed copies keep it');

  // the rung, from the owner's sheet
  await keeper.click('.fh-gear');
  if (!await keeper.until('the sheet', `!!document.querySelector('.sheet select')`)) return;
  expect(await keeper.inFrame(`return document.querySelectorAll('.sheet select option').length === 9 && document.querySelector('.sheet select').value === '2000'`), 'the sheet offers the nine rungs, on the default');
  await keeper.shot('2-sheet');
  await keeper.inFrame(`const s = document.querySelector('.sheet select'); s.value = '500'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  expect(await untilRows('the rung', '__fc_settings', (r) => r.find((x) => x.id === 'camjam.interval_ms' && x.cells.v === '500')), 'the rung is kept, on the ladder');
  await keeper.inFrame(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Done')?.setAttribute('data-done', ''); return true;`);
  await keeper.click('[data-done]');
  expect(await keeper.until('the note to follow', `!document.querySelector('.sheet') && /A 100px still, every 0\\.5s\\. No audio\\./.test(${text})`), 'the sheet closes and the note says the new rung');

  // no camera at all: the page says so and claims nothing
  await keeper.click('.bar .btn-primary');
  expect(await keeper.until('the camera error', `!!document.querySelector('.note.bad')`), 'with no camera, the page says it could not open one');
  expect(await keeper.inFrame(`return !document.querySelector('.cap') && /share my camera/.test(document.querySelector('.bar .btn-primary')?.textContent ?? '')`), 'and nothing is shared');
  await keeper.shot('3-no-camera');

  // a camera: stills go up, and come back down by the push
  await keeper.inFrame(FAKE_CAMERA);
  await keeper.click('.bar .btn-primary');
  expect(await keeper.until('the still to come back', `(document.querySelector('.stage-view img')?.src ?? '').startsWith('data:image/jpeg;base64,')`), "the keeper's own still comes back to their page");
  expect(await keeper.inFrame(`return document.querySelector('.cap .who')?.textContent === 'you' && /stop sharing/.test(${text}) && !document.querySelector('.note.bad')`), 'captioned as theirs, with stop sharing');
  expect(await keeper.inFrame(`return document.querySelector('.stage-view img').naturalWidth === 100`), 'the still is the rung\'s width');
  await keeper.shot('4-sharing');

  const visitor = await open();
  if (!await visitor.until('the feed to draw for a stranger', `(document.querySelector('.stage-view img')?.src ?? '').startsWith('data:image/jpeg;base64,')`)) return;
  expect(await visitor.inFrame(`return document.querySelector('.fh-mode')?.textContent === 'visitor' && !document.querySelector('.bar') && !document.querySelector('.fh-gear')`), 'a stranger watches, with nothing to press');
  expect(await visitor.inFrame(`return document.querySelector('.fh-title').disabled && document.querySelector('.fh-title').value === 'Workbench' && document.querySelector('.cap .who')?.textContent !== 'you'`), 'the title is not theirs, and the still is someone else\'s');
  const first = await visitor.inFrame(`return document.querySelector('.stage-view img').src`);
  expect(await visitor.until('a newer still', `document.querySelector('.stage-view img')?.src !== ${JSON.stringify(first)}`), 'new stills keep reaching the stranger');
  await visitor.shot('5-stranger-watching');

  // the keeper renames while sharing, and stops
  await keeper.clear('.fh-title');
  await keeper.fill('.fh-title', 'Bench cam');
  await keeper.press('Enter');
  expect(await visitor.until('the new title', `document.querySelector('.fh-title').value === 'Bench cam'`), 'a rename reaches the stranger');
  await keeper.inFrame(`[...document.querySelectorAll('.bar button')].find((b) => /stop sharing/.test(b.textContent))?.setAttribute('data-stop', ''); return true;`);
  await keeper.click('[data-stop]');
  expect(await keeper.until('the feed to end', `!document.querySelector('.cap') && /share my camera/.test(${text})`), 'the keeper stops sharing');
  expect(await visitor.until('the stranger to be told', `!document.querySelector('.cap') && /Nobody is sharing right now\\./.test(${text})`), 'and the stranger sees nobody sharing');
  await visitor.shot('6-stranger-idle');
  const kept = await rows('__fc_settings');
  expect(!kept.some((x) => /base64|jpeg/.test(JSON.stringify(x.cells))), 'no still was kept anywhere');
  await sleep(100);
};
