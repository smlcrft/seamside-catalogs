// Picture Frame in the viewer: the keeper adds real pictures and drives the wall, a stranger follows it.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// A PNG, drawn by `px(x, y)` → [r, g, b].
function png(w, h, px) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(t.length + 8);
    out.writeUInt32BE(data.length, 0); t.copy(out, 4); out.writeUInt32BE(crc(t), t.length + 4);
    return out;
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const dir = mkdtempSync(join(tmpdir(), 'picture-frame-'));
  const small = join(dir, 'tiles.png');
  writeFileSync(small, png(64, 48, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [200, 60, 40] : [40, 90, 200]));
  const big = join(dir, 'meadow.png');
  writeFileSync(big, png(3000, 2000, (x) => x < 1500 ? [30, 160, 90] : [240, 200, 40]));
  // The single view's controls fade when the pointer rests; a person moves it before clicking.
  const wake = (b) => b.inFrame(`document.querySelector('.wrap').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); await new Promise((r) => setTimeout(r, 300)); return true;`);
  const sha = (b) => createHash('sha256').update(b).digest('hex');

  if (!await keeper.until('the frame to draw', `!!document.querySelector('.wrap .bar h1')`)) return;
  expect(await keeper.until('the empty frame', `/No photos yet/.test(document.querySelector('.empty')?.textContent ?? '') && /Add photos/.test(document.querySelector('.bar')?.textContent ?? '')`), 'the keeper has an empty frame and a way to add photos');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.bar')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-empty');

  // a small PNG goes up as it is; a thumbnail beside it
  await keeper.choose('input[type="file"]', small);
  const one = await untilRows('the first photo', 'picture_frame_photos', (r) => r.find((x) => x.cells.name === 'tiles.png' && x.cells.thumb_path));
  expect(one?.cells.mime === 'image/png' && one?.cells.w === 64 && one?.cells.h === 48 && one?.cells.size === readFileSync(small).length && one?.cells.sort_order === 0, 'a picture chosen is a row of the space, measured, its bytes as they were');
  expect(one?.cells.path === `Picture Frame/${one?.id}/tiles.png` && one?.cells.thumb_path === `Picture Frame/${one?.id}/thumbnail.png` && one?.cells._created_at && one?.cells._modified_at, 'its file and its thumbnail are named on the row, stamped');
  expect(await keeper.until('the thumbnail to draw', `document.querySelector('.grid .cell img')?.naturalWidth > 0`), 'the grid draws the thumbnail, from bytes the worker handed over');
  const back = await keeper.inFrame(`
    const r = await window.seamside.fetch('/api/photo/${one?.id}');
    const d = await crypto.subtle.digest('SHA-256', r.bytes());
    return r.type + ' ' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');`);
  expect(back === `image/png ${sha(readFileSync(small))}`, 'the photo comes back byte for byte');

  // a large one is made smaller on the way in
  await keeper.choose('input[type="file"]', big);
  const two = await untilRows('the second photo', 'picture_frame_photos', (r) => r.find((x) => x.cells.name === 'meadow.png' && x.cells.thumb_path));
  expect(two?.cells.mime === 'image/jpeg' && two?.cells.w === 3000 && two?.cells.h === 2000 && two?.cells.sort_order === 1 && two?.cells.path === `Picture Frame/${two?.id}/meadow.jpg`, 'a large picture is re-encoded as JPEG, its natural size kept, after the first');
  expect(await keeper.until('two cells', `document.querySelectorAll('.grid .cell img').length === 2 && [...document.querySelectorAll('.grid .cell img')].every((i) => i.naturalWidth > 0)`), 'and both draw in the grid');
  expect(await keeper.until('the count', `/2 photos/.test(document.querySelector('.bar .count').textContent)`), 'the bar counts them');
  const full = await keeper.inFrame(`
    const r = await window.seamside.fetch('/api/photo/${two?.id}');
    const b = await createImageBitmap(new Blob([r.bytes()], { type: r.type }));
    return [r.type, b.width, b.height, r.bytes().length].join(' ');`);
  expect(full === `image/jpeg 2560 1707 ${two?.cells.size}`, `the stored photo is at most 2560 across (${full})`);
  await keeper.shot('2-grid');

  // the keeper puts the first up, and it fills the frame
  await keeper.click('.grid .cell:nth-child(1)');
  expect(await keeper.until('the single view', `document.querySelector('.single img')?.naturalWidth === 64`), 'a tap puts the photo up, full frame');
  await keeper.shot('3-single');

  const visitor = await open();
  if (!await visitor.until('the wall to draw for a stranger', `document.querySelector('.single img')?.naturalWidth === 64`)) return;
  expect(await visitor.inFrame(`return !document.querySelector('.tools .danger') && !document.querySelector('.tools select') && document.querySelectorAll('.tools button').length === 1`), 'a stranger sees what is up, with no way to change it');
  await visitor.shot('4-stranger-wall');

  // the keeper steps on: the stranger's page follows by itself
  await wake(keeper);
  await keeper.click('.nav.next');
  expect(await keeper.until('the next photo', `document.querySelector('.single img')?.naturalWidth === 2560`), 'Next moves the wall on');
  expect(await visitor.until('the stranger to follow', `document.querySelector('.single img')?.naturalWidth === 2560`), "and the stranger's open page follows");

  // a stranger browses on their own screen and moves nothing
  await wake(visitor);
  await visitor.click('.tools button');
  expect(await visitor.until('the grid', `document.querySelectorAll('.grid .cell img').length === 2`), 'a stranger can go back to the grid');
  expect(await visitor.inFrame(`return !document.querySelector('.cell .del') && !/Add photos/.test(document.querySelector('.bar').textContent)`), 'with no delete and no Add');
  await visitor.shot('5-stranger-grid');
  expect(await keeper.inFrame(`return document.querySelector('.single img')?.naturalWidth === 2560`), "and the keeper's wall did not move");

  // the keeper starts the show: the stranger rejoins the wall
  await wake(keeper);
  await keeper.click('.tools button[title="Start the slideshow"]');
  expect(await keeper.until('the show to run', `!!document.querySelector('.tools button.on[title="Stop the slideshow"]')`), 'Play starts the slideshow');
  expect(await visitor.until('the stranger back on the wall', `!!document.querySelector('.single img')`), 'and a stranger who was browsing rejoins the wall');
  await keeper.inFrame(`const s = document.querySelector('.tools select'); s.value = '5'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  expect(await keeper.until('the interval', `document.querySelector('.tools select').value === '5'`), 'an interval is chosen');
  const before = await keeper.inFrame(`return document.querySelector('.single img')?.naturalWidth`);
  expect(await keeper.until('the show to move on', `document.querySelector('.single img')?.naturalWidth !== ${before}`, 40), 'the show moves on by itself');
  expect(await visitor.until('the stranger to move with it', `document.querySelector('.single img')?.naturalWidth === ${before === 64 ? 2560 : 64}`, 40), "and the stranger's screen with it");
  await wake(keeper);
  await keeper.click('.tools button[title="Stop the slideshow"]');
  expect(await keeper.until('the show to stop', `!!document.querySelector('.tools button[title="Start the slideshow"]')`), 'Stop stops it');

  // deleting asks first
  await wake(keeper);
  await keeper.click('.tools button[title="Back to all photos"]');
  await keeper.until('the grid again', `document.querySelectorAll('.grid .cell').length === 2`);
  await keeper.inFrame(`document.querySelector('.grid .cell:nth-child(1) .del').style.opacity = 1; return true;`);
  await keeper.click('.grid .cell:nth-child(1) .del');
  await keeper.until('the question', `!!document.querySelector('.framelib-dialog-host .framelib-btn-danger')`);
  await keeper.shot('6-confirm');
  await keeper.click('.framelib-dialog-host .framelib-btn-ghost');
  await sleep(400);
  expect((await rows('picture_frame_photos')).length === 2, 'Cancel keeps the photo');
  await keeper.click('.grid .cell:nth-child(1) .del');
  await keeper.until('the question again', `!!document.querySelector('.framelib-dialog-host .framelib-btn-danger')`);
  await keeper.click('.framelib-dialog-host .framelib-btn-danger');
  expect(await untilRows('the photo to go', 'picture_frame_photos', (r) => r.length === 1 && r[0].id === two?.id), 'Delete removes it');
  expect(await keeper.until('one cell', `document.querySelectorAll('.grid .cell').length === 1 && /1 photo/.test(document.querySelector('.bar .count').textContent)`), 'and the grid follows');
  expect(await visitor.until('the stranger to lose it', `document.querySelectorAll('.single img, .grid .cell').length === 1`), "and the stranger's page too");
  await keeper.shot('7-after');
};
