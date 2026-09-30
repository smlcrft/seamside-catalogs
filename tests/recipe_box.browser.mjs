// Recipe Box in the viewer: the keeper fills the box, a photo included, searches it, cooks
// from a recipe and edits it; a stranger at the published address reads the same box live.

import { mkdtempSync, writeFileSync } from 'node:fs';
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

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-box-'));
  const photo = join(dir, 'ragu.png');
  writeFileSync(photo, png(1200, 800, (x, y) => ((x >> 5) + (y >> 5)) % 2 ? [190, 70, 40] : [240, 200, 120]));
  const small = join(dir, 'pie.png');
  writeFileSync(small, png(40, 30, () => [120, 160, 60]));

  const text = `(document.querySelector('main')?.textContent ?? '')`;
  const names = `[...document.querySelectorAll('.rcard .r-name')].map((e) => e.textContent)`;
  // Mark the card whose name matches, so a selector can name it.
  const mark = (b, name) => b.inFrame(`
    document.querySelectorAll('[data-t]').forEach((e) => e.removeAttribute('data-t'));
    const c = [...document.querySelectorAll('.rcard')].find((x) => x.querySelector('.r-name')?.textContent === ${JSON.stringify(name)});
    if (c) c.setAttribute('data-t', '1');
    return !!c;`);
  // What a data URI draws as, measured by the page.
  const size = (b, uri) => b.inFrame(`const i = new Image(); i.src = ${JSON.stringify(uri)}; await i.decode(); return i.naturalWidth + 'x' + i.naturalHeight;`);
  const blur = (b) => b.inFrame(`document.activeElement?.blur(); return true;`);

  if (!await keeper.until('the box to draw', `!!document.querySelector('main .header')`)) return;
  expect(await keeper.until('an empty box', `/Add your first recipe/.test(${text})`), 'the keeper has an empty box and a way to fill it');
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && getComputedStyle(document.querySelector('main')).display === 'flex' && !document.querySelector('.banner')`), 'the keeper is the owner, with no banner, and the page has its style');
  await keeper.shot('1-empty');

  const visitor = await open();
  if (!await visitor.until('the box to draw', `/Nothing here yet\\./.test(${text})`)) return;
  expect(await visitor.inFrame(`return /You're viewing this recipe box publicly\\./.test(${text}) && document.querySelector('.header .mode').textContent === 'viewer' && !document.querySelector('.notice') && !document.querySelector('.new-recipe')`), 'a stranger reads, with nothing to add');
  await visitor.shot('2-visitor-empty');

  // a new recipe, a photo with it
  await keeper.click('.notice .btn-primary');
  if (!await keeper.until('the new recipe sheet', `!!document.querySelector('.framelib-modal .ed')`)) return;
  expect(await keeper.inFrame(`return document.querySelector('.framelib-modal-actions .btn-primary').disabled`), 'Add waits for a title');
  await keeper.fill('.ed input[maxlength="200"][placeholder="Nonna\'s ragù"]', "Nonna's ragù");
  await keeper.fill('.ed input.f-serv', '4');
  await keeper.fill('.ed input[placeholder="weeknight, pasta"]', 'Pasta, Sunday, pasta');
  await keeper.fill('.ed textarea[maxlength="8000"]', '1 onion\n500 g beef\n1 tin tomatoes');
  await keeper.inFrame(`document.querySelectorAll('.ed textarea')[1].setAttribute('data-t', 'steps'); document.querySelectorAll('.ed textarea')[2].setAttribute('data-t', 'notes'); return true;`);
  await keeper.fill('.ed textarea[data-t="steps"]', 'Brown the beef\nAdd the tomatoes\nSimmer for hours');
  await keeper.fill('.ed textarea[data-t="notes"]', 'From Nonna. Less salt next time.');
  await keeper.choose('.ed input[type="file"]', photo);
  expect(await keeper.until('the thumbnail', `document.querySelector('.ed .pf-thumb')?.naturalWidth > 0`), 'a chosen photo is shown on the sheet');
  await keeper.shot('3-new-recipe');
  await keeper.click('.framelib-modal-actions .btn-primary');
  const ragu = await untilRows('the recipe', 'recipes', (r) => r.find((x) => x.cells.title === "Nonna's ragù"));
  expect(ragu?.cells.servings === 4 && ragu?.cells.tags === 'pasta,sunday' && ragu?.cells.ingredients_lines === '1 onion\n500 g beef\n1 tin tomatoes' && ragu?.cells.steps_lines === 'Brown the beef\nAdd the tomatoes\nSimmer for hours' && ragu?.cells.notes === 'From Nonna. Less salt next time.', 'the recipe is a row of the space, its fields as the contract holds them');
  expect(ragu?.cells.created_ms > 0 && ragu?.cells._created_at > 0 && ragu?.cells._modified_at > 0, 'stamped when it was made');
  const uri = ragu?.cells.photo ?? '';
  expect(/^data:image\/jpeg;base64,/.test(uri) && uri.length < 200000, 'the photo is a JPEG thumbnail in a data URI, under the contract\'s size');
  expect(await size(keeper, uri) === '512x341', 'downscaled to a longest edge of 512');
  expect(await keeper.until('the card to draw', `${names}.join('|') === "Nonna's ragù" && document.querySelector('.rcard .ptile img')?.naturalWidth === 512`), 'the shelf draws the card with its photo');
  expect(await visitor.until('the recipe to arrive by itself', `${names}.join('|') === "Nonna's ragù" && document.querySelector('.rcard .ptile img')?.naturalWidth === 512`), "the stranger's open page is told of it, photo and all");

  // a second, from the button under the shelf, a small image as it is
  await keeper.click('.new-recipe');
  await keeper.until('the sheet', `!!document.querySelector('.framelib-modal .ed')`);
  await keeper.fill('.ed input[placeholder="Nonna\'s ragù"]', 'Weeknight pie');
  await keeper.fill('.ed input[placeholder="weeknight, pasta"]', 'weeknight');
  await keeper.choose('.ed input[type="file"]', small);
  await keeper.until('the thumbnail', `document.querySelector('.ed .pf-thumb')?.naturalWidth > 0`);
  await keeper.click('.framelib-modal-actions .btn-primary');
  const pie = await untilRows('the second recipe', 'recipes', (r) => r.find((x) => x.cells.title === 'Weeknight pie'));
  expect(pie?.cells.servings === 0 && pie?.cells.tags === 'weeknight' && pie?.cells.notes === '' && /^data:image\/jpeg;base64,/.test(pie?.cells.photo ?? ''), 'a recipe with little in it starts from the defaults');
  expect(await size(keeper, pie?.cells.photo ?? '') === '40x30', 'a small photo keeps its size');

  // a recipe another frame or a table tool put in the table, in the contract's shape
  await seed('recipes', 'kept1', { title: 'apple crumble', ingredients_lines: '6 apples\nbutter', steps_lines: 'Bake', servings: 6, tags: 'dessert', notes: '', created_ms: 7 });
  await keeper.send('Page.reload');
  keeper.child = null;
  for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
  expect(await keeper.until('the shelf', `${names}.join('|') === "apple crumble|Nonna's ragù|Weeknight pie"`), 'a row in the contract\'s shape is on the shelf, by title');
  expect(await keeper.inFrame(`return [...document.querySelectorAll('button.tag')].map((t) => t.textContent).join(' ') === 'dessert pasta sunday weeknight'`), 'every tag is offered as a filter');
  await keeper.shot('4-shelf');

  await keeper.fill('.search input', 'nonna');
  expect(await keeper.until('the search', `${names}.join('|') === "Nonna's ragù"`), 'search finds by title');
  await keeper.clear('.search input');
  await keeper.fill('.search input', 'dess');
  expect(await keeper.until('the search by tag', `${names}.join('|') === 'apple crumble'`), 'and by tag');
  await keeper.clear('.search input');
  await keeper.fill('.search input', 'zzz');
  expect(await keeper.until('no matches', `/No matches\\./.test(${text})`), 'and says when nothing matches');
  await keeper.clear('.search input');
  await keeper.inFrame(`[...document.querySelectorAll('button.tag')].find((t) => t.textContent === 'weeknight').setAttribute('data-t', 'tag'); return true;`);
  await keeper.click('button.tag[data-t="tag"]');
  expect(await keeper.until('the filter', `${names}.join('|') === 'Weeknight pie'`), 'a tag filters the shelf');
  await keeper.click('button.tag.active');
  expect(await keeper.until('the filter to lift', `${names}.length === 3`), 'and clicking it again lifts the filter');

  // the cooking view
  await mark(keeper, "Nonna's ragù");
  await keeper.click('[data-t]');
  if (!await keeper.until('the recipe to open', `!!document.querySelector('.cook')`)) return;
  expect(await keeper.inFrame(`return [...document.querySelectorAll('ul.ing li')].map((e) => e.textContent).join('|') === '1 onion|500 g beef|1 tin tomatoes'
    && [...document.querySelectorAll('ol.steps li')].map((e) => e.textContent).join('|') === '1Brown the beef|2Add the tomatoes|3Simmer for hours'
    && document.querySelector('.notes-body').textContent === 'From Nonna. Less salt next time.'
    && document.querySelector('.subline').textContent === 'serves 4 · pasta · sunday'
    && document.querySelector('.hero').naturalWidth === 512`), 'the recipe reads as a card: ingredients, numbered steps, notes, its photo');
  await keeper.shot('5-cook');

  await keeper.fill('h1.t-title input', 'Ragù alla Nonna');
  await keeper.press('Enter');
  const renamed = await untilRows('the rename', 'recipes', (r) => r.find((x) => x.id === ragu?.id && x.cells.title === 'Ragù alla Nonna'));
  expect(renamed?.cells.photo === uri && renamed?.cells.created_ms === ragu?.cells.created_ms && renamed?.cells._created_at === ragu?.cells._created_at && renamed?.cells.servings === 4, 'a rename lands over the row, which kept what it held');

  await keeper.click('.rec-edit');
  if (!await keeper.until('the edit sheet', `!!document.querySelector('.framelib-modal .ed-del')`)) return;
  await keeper.clear('.ed input.f-serv');
  await keeper.fill('.ed input.f-serv', '6');
  await blur(keeper);
  expect(await untilRows('the servings', 'recipes', (r) => r.find((x) => x.id === ragu?.id && x.cells.servings === 6)), 'servings are kept as the field is left');
  await keeper.click('.ed textarea');
  await keeper.inFrame(`const t = document.querySelector('.ed textarea'); t.setSelectionRange(t.value.length, t.value.length); return true;`);
  await keeper.send('Input.insertText', { text: '\nbasil' }, keeper.child);
  await blur(keeper);
  expect(await untilRows('the ingredients', 'recipes', (r) => r.find((x) => x.id === ragu?.id && x.cells.ingredients_lines === '1 onion\n500 g beef\n1 tin tomatoes\nbasil')), 'an ingredient added is kept');
  await keeper.inFrame(`[...document.querySelectorAll('.ed .pf-btn')].find((b) => b.textContent.trim() === 'remove').setAttribute('data-t', 'rm'); return true;`);
  await keeper.click('.ed .pf-btn[data-t="rm"]');
  expect(await untilRows('the photo to go', 'recipes', (r) => r.find((x) => x.id === ragu?.id && x.cells.photo === '')), 'a photo is removed');
  expect(await keeper.until('the empty photo', `!!document.querySelector('.ed .pf-empty')`), 'and the sheet says so');
  await keeper.choose('.ed input[type="file"]', photo);
  const again = await untilRows('the photo to come back', 'recipes', (r) => r.find((x) => x.id === ragu?.id && /^data:image\/jpeg;base64,/.test(x.cells.photo)));
  expect(again && await size(keeper, again.cells.photo) === '512x341', 'and another put in its place, downscaled');
  await keeper.shot('6-edit');
  await keeper.click('.framelib-modal-actions button:last-child');
  expect(await keeper.until('the sheet to close', `!document.querySelector('.framelib-modal') && document.querySelector('.subline').textContent === 'serves 6 · pasta · sunday' && [...document.querySelectorAll('ul.ing li')].length === 4 && document.querySelector('.hero')?.naturalWidth === 512`), 'the card shows every change');

  // a stranger cooks from it and changes nothing
  expect(await visitor.until('the shelf to follow', `${names}.join('|') === "apple crumble|Ragù alla Nonna|Weeknight pie"`), "the stranger's shelf follows every change");
  await mark(visitor, 'Ragù alla Nonna');
  await visitor.click('[data-t]');
  expect(await visitor.until('the recipe to open', `!!document.querySelector('.cook') && document.querySelector('h1.t-title .static')?.textContent === 'Ragù alla Nonna'`), 'a stranger opens the recipe');
  expect(await visitor.inFrame(`return !document.querySelector('.rec-edit') && !document.querySelector('h1.t-title input') && [...document.querySelectorAll('ul.ing li')].length === 4 && document.querySelector('.hero')?.naturalWidth === 512`), 'and reads it, with nothing to edit');
  await visitor.shot('7-visitor-cook');

  // delete takes two presses
  await keeper.click('.rec-edit');
  await keeper.until('the edit sheet', `!!document.querySelector('.framelib-modal .ed-del')`);
  await keeper.click('.ed-del');
  expect(await keeper.inFrame(`return document.querySelector('.ed-del').classList.contains('armed') && document.querySelector('.ed-del').textContent.trim() === 'Click again to delete'`), 'the first press arms delete');
  expect((await rows('recipes')).length === 3, 'and deletes nothing yet');
  await keeper.click('.ed-del');
  expect(await untilRows('the delete', 'recipes', (r) => r.length === 2 && !r.some((x) => x.id === ragu?.id)), 'the second press deletes the row');
  expect(await keeper.until('the shelf again', `${names}.join('|') === 'apple crumble|Weeknight pie'`), 'and the keeper is back at the shelf');
  expect(await visitor.until('the stranger to be put back', `!document.querySelector('.cook') && ${names}.join('|') === 'apple crumble|Weeknight pie'`), "the stranger's page follows, off the recipe that went");
  await visitor.shot('8-visitor-after-delete');
};
