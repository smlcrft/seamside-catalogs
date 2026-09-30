// Slideshow in the viewer: the keeper builds a deck by hand — a slide, a heading typed in, a
// shape dragged, a picture chosen — and presents it; a stranger at the published address
// browses read-only and follows the presenter's slide.

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep, session }) => {
  const dir = mkdtempSync(join(tmpdir(), 'slideshow-'));
  const picture = join(dir, 'tiles.png');
  writeFileSync(picture, png(64, 48, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [200, 60, 40] : [40, 90, 200]));

  // What the daemon holds: the space's folder on disk.
  const spaces = join(process.env.SEAMSIDE1_DATA, 'profiles/default/spaces');
  // this session writes no keys of its own, so its space is the one whose sessions name it
  const space = readdirSync(spaces).map((d) => join(spaces, d))
    .find((d) => { try { return JSON.parse(readFileSync(join(d, '_meta/space.json'), 'utf8')).sessions.some((x) => x.id === session); } catch { return false; } });
  const deck = () => { try { return JSON.parse(readFileSync(join(space, 'Slideshow/slides.json'), 'utf8')); } catch { return null; } };
  const images = () => { try { return readdirSync(join(space, 'Slideshow/images')); } catch { return []; } };
  const until = async (what, test, tries = 60) => {
    for (let i = 0; i < tries; i++) { const v = test(); if (v) return v; await sleep(250); }
    expect(false, `the daemon came to hold ${what}`);
    console.log('  the deck is:', JSON.stringify(deck())?.slice(0, 600));
    return null;
  };
  const els = (d, i = 0) => d?.slides?.[i]?.elements ?? [];
  const main = `document.querySelector('.app > .stagewrap .stage')`;
  const at = (b, expr) => b.inFrame(`const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
  const drag = async (b, from, to) => {
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', buttons, clickCount: 1 }, b.child);
    await mouse('mousePressed', from, 1);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / 4, y: from.y + (to.y - from.y) * i / 4 }, 1);
    await mouse('mouseReleased', to, 0);
    await sleep(400);
  };
  const text = (b) => b.inFrame(`return document.querySelector('.app, .present')?.textContent ?? ''`);

  // an empty deck, and the way to start one
  if (!await keeper.until('the editor to draw', `/Start your presentation/.test(document.querySelector('.cta')?.textContent ?? '')`)) return;
  expect(await keeper.inFrame(`return !!document.querySelector('.topbar button[title="Add heading"]') && getComputedStyle(document.querySelector('.topbar')).display === 'flex'`), 'the keeper is an editor, and the page has its style');
  expect(deck() === null, 'opening the page writes nothing');
  await keeper.shot('1-empty');

  await keeper.click('.cta button');
  const one = await until('a first slide', () => deck()?.slides?.length === 1 && deck());
  expect(one?.settings?.aspect === '16:9' && one?.slides[0].background === 'inherit' && els(one).length === 0, 'Add a slide keeps a blank slide in Slideshow/slides.json');

  // a heading, typed into the inspector
  await keeper.click('.topbar button[title="Add heading"]');
  expect(await keeper.until('the inspector', `document.activeElement === document.querySelector('.inspector textarea') && document.querySelector('.inspector textarea').value === 'Heading'`), 'Add heading places one and puts the cursor in its text');
  await keeper.fill('.inspector textarea', 'Quarterly review');
  const titled = await until('the heading typed', () => els(deck()).find((e) => e.type === 'text' && e.text === 'Quarterly review'));
  expect(titled?.style === 'heading' && titled?.size === 64 && titled?.weight === 700 && titled?.align === 'center', 'what was typed is the heading, as a heading');
  expect(await keeper.until('the slide to show it', `/Quarterly review/.test(${main}.textContent)`), 'and the slide shows it');
  await keeper.inFrame(`const s = document.querySelector('.inspector select'); s.value = 'subheading'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  expect(await until('the style changed', () => els(deck()).find((e) => e.text === 'Quarterly review' && e.style === 'subheading' && e.size === 40 && e.weight === 600)), 'a new style brings its size and weight');
  await keeper.click('.inspector button[title="Close"]');

  // a shape, dragged by hand
  await keeper.click('.topbar button[title="Add rectangle"]');
  const rect = await until('a rectangle', () => els(deck()).find((e) => e.type === 'shape'));
  expect(rect?.shape === 'rect' && rect?.fill === 'accent' && rect?.w === 280 && rect?.h === 170, 'Add rectangle keeps a rectangle in the accent');
  await keeper.click('.inspector button[title="Close"]');
  const from = await at(keeper, `[...${main}.querySelectorAll('.el')].pop()`);
  const scale = await keeper.inFrame(`return ${main}.getBoundingClientRect().width / 1280`);
  await drag(keeper, from, { x: from.x + 100 * scale, y: from.y + 50 * scale });
  const moved = await until('the rectangle moved', () => { const e = els(deck()).find((x) => x.id === rect?.id); return e && e.x !== rect.x && e; });
  expect(moved && Math.abs(moved.x - rect.x - 100) <= 3 && Math.abs(moved.y - rect.y - 50) <= 3, `a drag moves it on the slide by as much (${moved?.x - rect?.x}, ${moved?.y - rect?.y})`);
  expect(await keeper.inFrame(`return !!document.querySelector('.inspector') && document.querySelector('.inspector .lbl').textContent === 'shape'`), 'and leaves it chosen');
  await keeper.inFrame(`[...document.querySelectorAll('.inspector .swatch')].find((s) => s.title === 'text').setAttribute('data-pick', ''); return true;`);
  await keeper.click('.inspector .swatch[data-pick]');
  expect(await until('the fill changed', () => els(deck()).find((e) => e.id === rect?.id && e.fill === 'text')), 'a swatch fills it');
  await keeper.click('.inspector button[title="Close"]');

  // a picture, chosen
  await keeper.choose('input[type="file"]', picture);
  const pic = await until('the picture placed', () => els(deck()).find((e) => e.type === 'image' && e.imageId));
  expect(pic && images().includes(`${pic.imageId}.png`) && readFileSync(join(space, `Slideshow/images/${pic.imageId}.png`)).equals(readFileSync(picture)), 'a picture chosen is a file of the space, byte for byte, and on the slide');
  expect(await keeper.until('the picture to draw', `${main}.querySelector('img')?.naturalWidth === 64`), 'the slide draws it, from bytes the worker handed over');
  expect(await keeper.until('the thumbnail to draw', `document.querySelector('.thumb img')?.naturalWidth === 64`), 'and so does its thumbnail');
  await keeper.click('.inspector button[title="Close"]');
  await keeper.shot('2-slide');

  // a second slide, and the show's settings
  await keeper.click('.filmstrip button[title="Add slide"]');
  expect(await until('a second slide', () => deck()?.slides?.length === 2 && els(deck(), 1).length === 0), 'Add slide puts a blank one after');
  await keeper.click('.topbar button[title="Add text"]');
  await keeper.fill('.inspector textarea', 'Thanks for coming');
  expect(await until('the second slide\'s words', () => els(deck(), 1).find((e) => e.text === 'Thanks for coming' && e.style === 'body')), 'the second slide says its words');
  await keeper.click('.inspector button[title="Close"]');
  expect(await keeper.until('two thumbnails', `document.querySelectorAll('.thumb').length === 2 && document.querySelector('.thumb:nth-child(2)').classList.contains('active')`), 'the filmstrip holds both, the new one chosen');
  await keeper.click('.topbar button[title="Show settings"]');
  await keeper.until('the settings', `/show settings/.test(document.querySelector('.inspector .lbl')?.textContent ?? '')`);
  await keeper.click('.synctoggle input');
  expect(await until('the viewers kept in sync', () => deck()?.settings?.syncPresent === true && deck().slides.length === 2), 'Keep viewers in sync is a setting of the deck');
  await keeper.shot('3-settings');
  await keeper.press('Escape');
  await keeper.until('the settings to close', `!document.querySelector('.inspector')`);
  if (await keeper.inFrame(`return !!document.querySelector('.inspector')`)) await keeper.click('.inspector button[title="Close"]');

  // a stranger at the published address browses read-only, on the presenter's slide
  const visitor = await open();
  if (!await visitor.until('the deck to draw for a stranger', `/1 \\/ 2 · following presenter/.test(document.querySelector('.viewerbar')?.textContent ?? '')`)) return;
  expect(await visitor.inFrame(`return !document.querySelector('.filmstrip') && !document.querySelector('.topbar button[title="Add heading"]') && document.querySelectorAll('.topbar button').length === 1`), 'a stranger has no way to edit, only Present');
  expect(await visitor.until('the stranger\'s picture', `document.querySelector('.stage img')?.naturalWidth === 64 && /Quarterly review/.test(document.querySelector('.stage').textContent)`), 'and sees the slide, its picture served to them too');
  expect(await keeper.until('the keeper to see a watcher', `document.querySelector('.vcount')?.textContent.trim() === '1'`), 'the keeper sees one person watching');
  await visitor.shot('4-stranger');

  // the keeper presents, and the stranger follows
  await keeper.click('.filmstrip .thumb:nth-child(1)');
  await keeper.click('.topbar button[title="Present"]');
  expect(await keeper.until('present mode', `/1 \\/ 2/.test(document.querySelector('.pcount-fixed')?.textContent ?? '') && /1 watching/.test(document.querySelector('.pcount-fixed').textContent)`), 'Present shows the first slide, and who is watching');
  await keeper.shot('5-present');
  await keeper.click('.pnav.right');
  expect(await untilRows('the presenter\'s slide', '__fc_settings', (r) => r.find((x) => x.id === 'slideshow_present' && x.cells.v === '1' && x.cells._created_at && x.cells._modified_at)), 'the next slide is the presenter\'s, kept where it was, as a setting');
  expect(await keeper.until('the second slide presented', `/2 \\/ 2/.test(document.querySelector('.pcount-fixed').textContent) && /Thanks for coming/.test(document.querySelector('.present .stage').textContent)`), 'the keeper is on the second slide');
  expect(await visitor.until('the stranger to follow', `/2 \\/ 2 · following presenter/.test(document.querySelector('.viewerbar')?.textContent ?? '') && /Thanks for coming/.test(document.querySelector('.stage').textContent)`), "and the stranger's open page follows");

  // the stranger presents too, and follows rather than drives
  await visitor.click('.topbar button[title="Present"]');
  expect(await visitor.until('the stranger presenting', `/2 \\/ 2 · following presenter/.test(document.querySelector('.pcount-fixed')?.textContent ?? '') && !document.querySelector('.pnav')`), 'a stranger presenting follows, with no way to move the show');
  await keeper.click('.pnav.left');
  expect(await visitor.until('the stranger taken back', `/1 \\/ 2 · following presenter/.test(document.querySelector('.pcount-fixed')?.textContent ?? '')`), 'and is taken back when the presenter goes back');
  await visitor.shot('6-stranger-present');
  await visitor.press('Escape');
  await keeper.press('Escape');
  expect(await keeper.until('the editor again', `!!document.querySelector('.filmstrip')`), 'Escape ends presenting');

  // an edit reaches the stranger by itself
  // the picture lies over the heading's middle, so the heading is taken by its top edge
  const top = await keeper.inFrame(`const r = ${main}.querySelector('.el').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 6 };`);
  for (const type of ['mousePressed', 'mouseReleased']) await keeper.send('Input.dispatchMouseEvent', { type, x: Math.round(top.x), y: Math.round(top.y), button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, keeper.child);
  await keeper.until('the heading chosen', `document.querySelector('.inspector .lbl')?.textContent === 'text'`);
  await keeper.fill('.inspector textarea', 'Year in review');
  expect(await until('the heading retyped', () => els(deck()).find((e) => e.text === 'Year in review')), 'the heading is typed again');
  await keeper.click('.inspector button[title="Close"]');
  expect(await visitor.until('the stranger to see it', `/Year in review/.test(document.querySelector('.stage').textContent)`), "the stranger's page shows the change");

  // taking the picture out takes its file
  await keeper.inFrame(`${main}.querySelector('img').closest('.el').setAttribute('data-pick', ''); return true;`);
  await keeper.click('.app > .stagewrap .el[data-pick]');
  await keeper.until('the picture chosen', `document.querySelector('.inspector .lbl')?.textContent === 'image'`);
  await keeper.click('.inspector button[title="Delete"]');
  expect(await until('the picture gone', () => !els(deck()).some((e) => e.type === 'image') && !images().includes(`${pic?.imageId}.png`)), 'deleting the picture takes it off the slide and out of the space');
  expect(await visitor.until('the stranger without it', `!document.querySelector('.stage img')`), "and off the stranger's page");
  expect((await text(visitor)).includes('Year in review') && (await rows('__fc_settings')).length === 1, 'the rest is as it was, and nothing else was kept as a setting');
  await keeper.shot('7-after');
};
