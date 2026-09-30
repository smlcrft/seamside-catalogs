// Watercolor Studio in the viewer: the keeper paints with the pointer, mixes, undoes, sets the
// paper and title, saves the picture and clears the sheet; a stranger at the published
// address watches it replay and follow, and paints nothing.

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The page's subtractive mix, for what a stroke's pigment should be.
const PANS = { lemon: '#f2dd4e', ultra: '#2f4b9b' };
function mixed(ids) {
  const acc = [0, 0, 0];
  for (const id of ids) {
    const n = parseInt(PANS[id].slice(1), 16);
    [(n >> 16) & 255, (n >> 8) & 255, n & 255].forEach((v, c) => { acc[c] += Math.log(Math.max(v / 255, 0.018)); });
  }
  return '#' + acc.map((a) => Math.max(0, Math.min(255, Math.round(Math.exp(a / ids.length) * 255))).toString(16).padStart(2, '0')).join('');
}

export default async ({ keeper, visitor: open, expect, sleep, session }) => {
  // What the daemon holds: the space's folder on disk, and the sheet and prefs as the worker answers them.
  const spaces = join(process.env.SEAMSIDE1_DATA, 'profiles/default/spaces');
  // the space whose space.json runs this session (its state folder comes only with its first key)
  const spaceDir = () => readdirSync(spaces).map((d) => join(spaces, d)).find((d) => {
    try { return JSON.parse(readFileSync(join(d, '_meta/space.json'), 'utf8')).sessions?.some((x) => x.id === session); } catch { return false; }
  });
  const onDisk = (path) => { try { return readFileSync(join(spaceDir(), path)); } catch { return null; } };
  const sheet = () => { try { return JSON.parse(onDisk('_fdata/paintings/Painting/strokes.json')).strokes; } catch { return null; } };
  const state = () => keeper.inFrame(`const r = await window.seamside.fetch('/api/state'); return r.json();`);
  const prefs = async () => (await state()).prefs;
  const until = async (what, test, tries = 60) => {
    for (let i = 0; i < tries; i++) { const v = await test(); if (v) return v; await sleep(250); }
    expect(false, `the daemon came to hold ${what}`);
    return null;
  };
  const isPng = (b) => b && b.length > 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
  const size = (b) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;

  // A pointer drag across the sheet, from and to fractions of it.
  const drag = async (b, from, to) => {
    const r = await b.inFrame(`const r = document.querySelector('#ws-live').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height };`);
    const at = ([fx, fy]) => ({ x: Math.round(r.x + r.w * fx), y: Math.round(r.y + r.h * fy) });
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons, clickCount: 1 }, b.child);
    await mouse('mousePressed', at(from), 1);
    for (let i = 1; i <= 12; i++) {
      await mouse('mouseMoved', at([from[0] + (to[0] - from[0]) * i / 12, from[1] + (to[1] - from[1]) * i / 12]), 1);
      await sleep(16);
    }
    await mouse('mouseReleased', at(to), 0);
  };
  // How much paint the painting canvas holds at a fraction of the sheet (its alpha, 0–255).
  const paintAt = (b, fx, fy) => b.inFrame(`
    const c = document.querySelector('#ws-paint');
    return c.getContext('2d').getImageData(Math.round(c.width * ${fx}), Math.round(c.height * ${fy}), 1, 1).data[3];`);
  const meta = `document.querySelector('#ws-meta')?.textContent`;

  // ----- the keeper's empty sheet
  if (!await keeper.until('the studio to draw', `!!document.querySelector('.ws-root #ws-live') && ${meta} === '0 strokes'`)) return;
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.ws-sheet')).position === 'absolute' && document.querySelector('#ws-paint').width > 100`), 'the page has its style and a sized sheet');
  expect(await keeper.inFrame(`return document.querySelectorAll('.ws-tool-btn[data-brush]').length === 6 && document.querySelectorAll('.ws-pan').length === 16 && !document.querySelector('#ws-settings-btn').hidden && !document.querySelector('#ws-title-input').disabled && !document.querySelector('.ws-readonly-tag')`), 'the owner has brushes, pans, settings and the title');
  expect(await keeper.inFrame(`return document.querySelector('#ws-save-btn').hidden`), 'there is nothing to save yet');
  await keeper.shot('1-empty');

  // ----- a stroke, by the pointer, with the well's starting ultramarine
  await drag(keeper, [0.25, 0.4], [0.65, 0.45]);
  const one = await until('the first stroke', () => sheet()?.length === 1 && sheet());
  const s1 = one?.[0];
  expect(s1?.brush === 'round' && s1?.pigment === PANS.ultra && s1?.water === 0.52 && s1?.points.length >= 5 && s1?.id.startsWith('s_') && s1?.created_by_user_id.startsWith('did:'), `a stroke drawn is a stroke of the sheet's file, as painted (${JSON.stringify(s1)?.slice(0, 200)})`);
  expect(s1 && Math.abs(s1.points[0][0] - 0.25) < 0.02 && Math.abs(s1.points.at(-1)[0] - 0.65) < 0.02, 'where it was painted');
  expect((await state()).sheet === 'paintings/Painting', 'the sheet is a folder of the frame data folder, named by the session\'s sheet key');
  expect(await keeper.until('the count', `${meta} === '1 stroke' && !document.querySelector('#ws-save-btn').hidden`), 'the page counts it and offers to save');
  expect(await paintAt(keeper, 0.45, 0.42) > 0, 'and the paint is on the canvas');

  // the picture, rendered by the page and sent up as bytes
  const pic = await until('the picture', () => isPng(onDisk('_fdata/paintings/Painting/painting.png')) && onDisk('_fdata/paintings/Painting/painting.png'), 80);
  expect(pic && size(pic) === '1600x1067', `painting.png is a PNG of the sheet, 1600 across (${pic && size(pic)})`);
  const tint = await keeper.inFrame(`
    const r = await window.seamside.fetch('/api/picture');
    const bmp = await createImageBitmap(new Blob([r.bytes()], { type: r.type }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const px = (fx, fy) => [...x.getImageData(Math.round(bmp.width * fx), Math.round(bmp.height * fy), 1, 1).data];
    return { type: r.type, len: r.bytes().length, paint: px(0.45, 0.42), paper: px(0.5, 0.9) };`);
  expect(tint?.type === 'image/png' && tint?.len === pic?.length, 'the picture comes back from the worker byte for byte');
  expect(tint && tint.paint[2] - tint.paint[0] > 20 && tint.paper[0] > 240 && tint.paper[2] > 235, `and shows blue paint on cold-press paper (${JSON.stringify(tint)})`);
  await keeper.shot('2-first-stroke');

  // ----- a stranger watches
  const visitor = await open();
  if (!await visitor.until('the studio for a stranger', `!!document.querySelector('.ws-readonly-tag') && ${meta} === 'view only'`)) return;
  expect(await visitor.inFrame(`return getComputedStyle(document.querySelector('#ws-deck')).display === 'none' && document.querySelector('#ws-settings-btn').hidden && document.querySelector('#ws-title-input').disabled`), 'a stranger has no brushes, no palette, no settings and no title to change');
  expect(await visitor.until('the painting to replay', `(() => { const c = document.querySelector('#ws-paint'); return c.getContext('2d').getImageData(Math.round(c.width * 0.45), Math.round(c.height * 0.42), 1, 1).data[3] > 0; })()`), 'the painting replays for a stranger');
  await drag(visitor, [0.2, 0.8], [0.8, 0.8]);
  await sleep(800);
  expect(sheet()?.length === 1, 'a stranger\'s drag lays down nothing');
  const refused = await visitor.inFrame(`const r = await window.seamside.fetch('/api/stroke/add', { method: 'POST', body: JSON.stringify({ brush: 'round', pigment: '#123456', points: [[0.5, 0.5, 1]] }) }); return r.status;`);
  expect(refused === 403 && sheet()?.length === 1, 'and the worker refuses a stranger\'s stroke');
  const upRefused = await visitor.inFrame(`const r = await window.seamside.fetch('/api/picture?last=x', { method: 'POST', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]) }); return r.status;`);
  expect(upRefused === 403, 'and a stranger\'s picture');
  await visitor.shot('3-stranger');

  // ----- a green mixed in the well, laid with the wash; the stranger follows
  expect(await visitor.inFrame(`const c = document.querySelector('#ws-paint'); return c.getContext('2d').getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.72), 1, 1).data[3];`) === 0, 'the lower sheet is bare for the stranger');
  await keeper.click('#ws-rinse');
  expect(await keeper.until('an empty well', `document.querySelector('#ws-well').classList.contains('empty') && /tap a pan/.test(document.querySelector('#ws-recipe').textContent)`), 'Rinse empties the well');
  await keeper.click('.ws-pan[data-pid="lemon"]');
  await keeper.click('.ws-pan[data-pid="ultra"]');
  expect(await keeper.until('two chips', `document.querySelectorAll('.ws-recipe-chip').length === 2`), 'two pans go into the well');
  await keeper.click('.ws-tool-btn[data-brush="wash"]');
  await keeper.click('.ws-water-btn[data-water="loaded"]');
  expect(await keeper.inFrame(`return document.querySelector('.ws-tool-btn[data-brush="wash"]').getAttribute('aria-pressed') === 'true'`), 'the wash is the brush');
  await drag(keeper, [0.3, 0.72], [0.7, 0.72]);
  const two = await until('the second stroke', () => sheet()?.length === 2 && sheet());
  expect(two?.[1]?.brush === 'wash' && two?.[1]?.pigment === mixed(['lemon', 'ultra']) && two?.[1]?.water === 0.18 && two?.[0]?.id === s1?.id, `a stroke of the mix goes after the first (${two?.[1]?.pigment} for ${mixed(['lemon', 'ultra'])})`);
  expect(await keeper.until('two strokes', `${meta} === '2 strokes'`), 'the page counts two');
  expect(await visitor.until('the stranger to follow', `(() => { const c = document.querySelector('#ws-paint'); return c.getContext('2d').getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.72), 1, 1).data[3] > 0; })()`), "the stranger's open page is told and paints it");
  await keeper.shot('4-two-strokes');
  await visitor.shot('5-stranger-follows');

  // ----- undo takes the keeper's last stroke off, for both
  await keeper.click('.ws-tool-btn[title="Undo my last stroke"]');
  const undone = await until('the undo', () => sheet()?.length === 1 && sheet());
  expect(undone?.[0]?.id === s1?.id, 'Undo takes the last stroke off the sheet\'s file');
  expect(await keeper.until('one stroke', `${meta} === '1 stroke'`) && await paintAt(keeper, 0.5, 0.72) === 0, 'and off the page');
  expect(await visitor.until('the stranger to follow the undo', `(() => { const c = document.querySelector('#ws-paint'); return c.getContext('2d').getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.72), 1, 1).data[3] === 0; })()`), "and off the stranger's page");

  // ----- the owner's paper and title are the session's prefs setting
  await keeper.click('#ws-settings-btn');
  expect(await keeper.until('the settings', `document.querySelector('#ws-settings-pop').classList.contains('open')`), 'the settings open');
  await keeper.inFrame(`[...document.querySelectorAll('#ws-set-paper .ws-seg-btn')].find((b) => b.textContent === 'Kraft').setAttribute('data-t', 'kraft'); return true;`);
  await keeper.click('[data-t="kraft"]');
  expect(await until('the paper', async () => (await prefs()).paper === 'kraft'), 'Kraft is kept as the session\'s prefs setting');
  expect(await keeper.until('the paper to show', `document.querySelector('#ws-sheet').style.backgroundColor === 'rgb(231, 218, 191)'`), 'and the sheet turns kraft');
  expect(await visitor.until('the stranger\'s paper', `document.querySelector('#ws-sheet').style.backgroundColor === 'rgb(231, 218, 191)'`), "and the stranger's too");
  await keeper.fill('#ws-title-input', 'Harbour');
  await keeper.press('Enter');
  expect(await until('the title', async () => { const p = await prefs(); return p.title === 'Harbour' && p.paper === 'kraft'; }), 'the title is kept beside the paper');
  expect(await visitor.until('the stranger\'s title', `document.querySelector('#ws-title-input').value === 'Harbour'`), 'and the stranger sees it');
  await keeper.shot('6-kraft');

  // ----- Save hands the picture to the viewer, which saves it
  // the paper and the title each render the picture again: take the one that stopped changing
  let pic2 = null;
  await until('the picture on kraft, settled', async () => {
    const b = onDisk('_fdata/paintings/Painting/painting.png');
    if (!isPng(b) || !pic || b.equals(pic)) return false;
    await sleep(1500);
    const again = onDisk('_fdata/paintings/Painting/painting.png');
    return isPng(again) && again.equals(b) && (pic2 = b);
  }, 80);
  const saved = mkdtempSync(join(tmpdir(), 'watercolor-'));
  await keeper.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: saved }).catch(() => keeper.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: saved }));
  await keeper.click('#ws-save-btn');
  const got = await until('a saved picture', () => { try { return readFileSync(join(saved, 'Harbour.png')); } catch { return null; } });
  expect(got && pic2 && got.equals(pic2), 'Save saves painting.png as it is, named for the title');

  // ----- a stranger saves it too
  const asked = await visitor.inFrame(`
    window.__saved = null;
    const real = window.seamside.saveFile;
    window.seamside.saveFile = async (name, blob) => { window.__saved = { name, size: blob.size, type: blob.type }; };
    document.querySelector('#ws-save-btn').click();
    for (let i = 0; i < 40 && !window.__saved; i++) await new Promise((r) => setTimeout(r, 100));
    window.seamside.saveFile = real;
    return window.__saved;`);
  expect(asked?.name === 'Harbour.png' && asked?.size === pic2?.length && asked?.type === 'image/png', `a stranger's Save hands over the picture (${JSON.stringify(asked)})`);

  // ----- the owner clears the sheet
  await keeper.click('#ws-settings-btn');
  await keeper.until('the settings again', `document.querySelector('#ws-settings-pop').classList.contains('open')`);
  await keeper.click('#ws-clear-btn');
  if (!await keeper.until('the confirm', `/Clear the entire sheet\\?/.test(document.querySelector('.framelib-prompt-msg')?.textContent ?? '')`)) return;
  await keeper.click('.framelib-dialog-host .framelib-btn-danger');
  expect(await until('the sheet cleared', () => !onDisk('_fdata/paintings/Painting/strokes.json') && !onDisk('_fdata/paintings/Painting/painting.png')), 'Clear removes the sheet\'s files');
  expect(await keeper.until('an empty sheet', `${meta} === '0 strokes' && document.querySelector('#ws-save-btn').hidden`), 'the page is empty');
  expect(await visitor.until('the stranger\'s empty sheet', `(() => { const c = document.querySelector('#ws-paint'); return c.getContext('2d').getImageData(Math.round(c.width * 0.45), Math.round(c.height * 0.42), 1, 1).data[3] === 0; })()`), "and so is the stranger's");
  await keeper.shot('7-cleared');

  // ----- the next stroke starts again in the same folder, on a page opened afresh
  await keeper.send('Page.reload');
  keeper.child = null;
  for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
  if (!await keeper.until('the studio again', `${meta} === '0 strokes' && document.querySelector('#ws-title-input').value === 'Harbour'`)) return;
  await drag(keeper, [0.4, 0.3], [0.6, 0.35]);
  expect(await until('a stroke again', () => sheet()?.length === 1 && sheet()[0].pigment === PANS.ultra), 'a stroke after clearing starts the sheet again where it was');
  await keeper.shot('8-again');
};
