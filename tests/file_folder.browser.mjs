// File Folder in the viewer: the keeper adds real files by the chooser and by a drop, sets
// who may add, moves the folder; a stranger at the published address lists and downloads.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async ({ keeper, visitor: open, expect, sleep, session }) => {
  const dir = mkdtempSync(join(tmpdir(), 'file-folder-'));
  const saved = join(dir, 'saved');
  // every byte value, so nothing survives a text round trip by luck
  const sample = join(dir, 'sample.bin');
  writeFileSync(sample, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff)));
  const dropped = join(dir, 'dropped notes.txt');
  writeFileSync(dropped, 'dropped in by hand\n');
  const sha = (b) => createHash('sha256').update(b).digest('hex');

  // What the daemon holds: the space's folder on disk, and this session's settings as the worker answers them.
  const spaces = join(process.env.SEAMSIDE1_DATA, 'profiles/default/spaces');
  // looked up when asked: the session's folder is made when it first keeps something
  const space = () => readdirSync(spaces).map((d) => join(spaces, d)).find((d) => existsSync(join(d, '_meta/sessions', session)));
  const onDisk = (path) => { try { return readFileSync(join(space(), path)); } catch { return null; } };
  const settings = () => keeper.inFrame(`const r = await window.seamside.fetch('/api/state'); const s = r.json(); return { prefs: s.prefs, folder: s.folder };`);
  const until = async (what, test, tries = 60) => {
    for (let i = 0; i < tries; i++) { const v = await test(); if (v) return v; await sleep(250); }
    expect(false, `the daemon came to hold ${what}`);
    return null;
  };
  const names = `[...document.querySelectorAll('.file .name')].map((n) => n.textContent).join('|')`;
  const fetched = (b, name) => b.inFrame(`
    const r = await window.seamside.fetch('/api/download/' + encodeURIComponent(${JSON.stringify(name)}));
    const d = await crypto.subtle.digest('SHA-256', r.bytes());
    return r.status + ' ' + [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');`);
  const drop = async (b, path) => {
    const at = await b.inFrame(`const r = document.querySelector('.drop').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
    const carry = (type) => b.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: { items: [], files: [path], dragOperationsMask: 1 } }, b.child);
    await carry('dragEnter');
    for (let i = 0; i < 3; i++) { await carry('dragOver'); await sleep(50); }
    const over = await b.inFrame(`return document.querySelector('.drop').classList.contains('over') && /Drop to add/.test(document.querySelector('.drop .big').textContent);`);
    await carry('drop');
    return over;
  };

  if (!await keeper.until('the folder to draw', `document.querySelector('main .header h1')?.textContent === 'File Folder'`)) return;
  expect(await keeper.until('an empty folder', `/No files yet\\. Add one above\\./.test(document.querySelector('main').textContent) && document.querySelector('.header .mode').textContent === 'owner'`), 'the keeper has an empty folder and a way to add');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.drop')).borderStyle === 'dashed' && document.querySelector('.where .path').textContent === 'File Folder/'`), 'the page has its style, and says the folder it keeps');
  await keeper.shot('1-empty');

  // a file chosen goes up byte for byte, into the space's folder
  await keeper.choose('input[type="file"]', sample);
  const kept = await until('the chosen file', () => onDisk('File Folder/sample.bin'));
  expect(kept && sha(kept) === sha(readFileSync(sample)), 'a chosen file is a file of the space, its bytes as they were');
  expect(await keeper.until('the file to list', `${names} === 'sample.bin' && /1\\s*file · 5 KB/.test(document.querySelector('.airhero').textContent)`), 'and is listed, counted and sized');
  expect(await fetched(keeper, 'sample.bin') === `200 ${sha(readFileSync(sample))}`, 'it comes back from the worker byte for byte');
  await keeper.shot('2-one-file');

  // Download saves it as it is
  await keeper.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: saved }).catch(() => keeper.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: saved }));
  await keeper.click('.file .iconbtn.dl');
  const got = await until('a saved download', () => onSaved(saved, 'sample.bin'));
  expect(got && sha(got) === sha(readFileSync(sample)), 'Download saves the file byte for byte');

  // a stranger at the published address lists and downloads, and adds nothing
  const visitor = await open();
  if (!await visitor.until('the folder for a stranger', `${names} === 'sample.bin'`)) return;
  expect(await visitor.inFrame(`return !document.querySelector('.drop') && !document.querySelector('.iconbtn.del') && !document.querySelector('.gear') && !document.querySelector('.where .move') && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger sees the files, with no way to add, delete, set or move');
  expect(await fetched(visitor, 'sample.bin') === `200 ${sha(readFileSync(sample))}`, 'and downloads one byte for byte');
  const refused = await visitor.inFrame(`const r = await window.seamside.fetch('/api/upload?name=mine.txt', { method: 'POST', body: new Uint8Array([1, 2, 3]) }); return r.status;`);
  expect(refused === 403 && !onDisk('File Folder/mine.txt'), 'the worker refuses a stranger\'s upload');
  await visitor.shot('3-stranger');

  // a file dropped on the page goes up too, and the stranger's page follows by itself
  expect(await drop(keeper, dropped), 'a file carried over the page says it can be dropped');
  const fromDrop = await until('the dropped file', () => onDisk('File Folder/dropped notes.txt'));
  expect(fromDrop?.toString() === 'dropped in by hand\n', 'a dropped file is a file of the space, as it was');
  expect(await keeper.until('two files', `${names} === 'dropped notes.txt|sample.bin'`), 'and is listed beside the first');
  expect(await visitor.until('the stranger to follow', `${names} === 'dropped notes.txt|sample.bin'`), "the stranger's open page is told of it");

  // the same name again is given another
  await keeper.choose('input[type="file"]', sample);
  const second = await until('the second copy', () => onDisk('File Folder/sample (2).bin'));
  expect(second && sha(second) === sha(readFileSync(sample)) && sha(onDisk('File Folder/sample.bin')) === sha(readFileSync(sample)), 'a name taken is kept as "sample (2).bin", and the first is untouched');
  await keeper.until('three files', `document.querySelectorAll('.file').length === 3`);

  // delete asks twice
  await keeper.inFrame(`[...document.querySelectorAll('.file')].find((f) => f.querySelector('.name').textContent === 'sample (2).bin').querySelector('.iconbtn.del').setAttribute('data-t', 'del'); return true;`);
  await keeper.click('[data-t="del"]');
  expect(await keeper.inFrame(`return document.querySelector('[data-t="del"]').classList.contains('armed') && document.querySelector('[data-t="del"]').title === 'Click again to delete'`) && onDisk('File Folder/sample (2).bin'), 'the first click on delete only arms it');
  await keeper.shot('4-armed');
  await keeper.click('[data-t="del"]');
  expect(await until('the file gone', () => !onDisk('File Folder/sample (2).bin')), 'the second deletes the file from the space');
  expect(await keeper.until('two files again', `${names} === 'dropped notes.txt|sample.bin'`), 'and the list follows');

  // the owner's settings are the session's prefs setting
  await keeper.click('.gear');
  await keeper.until('the settings', `!!document.querySelector('.settings')`);
  await keeper.click('.seg button:nth-child(2)');
  expect(await until('who may add', async () => (await settings()).prefs.who_can_add === 'editors'), 'Owner & editors is kept as the session\'s prefs setting');
  expect(await keeper.until('the choice to show', `document.querySelector('.seg button:nth-child(2)').classList.contains('active')`), 'and shows as chosen');
  const setLimit = async (nth, value) => {
    await keeper.fill(`.limits .field:nth-child(${nth}) input`, value);
    await keeper.inFrame(`document.activeElement.blur(); return true;`);
  };
  await setLimit(1, '1');
  expect(await until('a size cap', async () => (await settings()).prefs.max_size_mb === 1), 'a size cap is kept');
  const big = await keeper.inFrame(`const r = await window.seamside.fetch('/api/upload?name=big.bin', { method: 'POST', body: new Uint8Array(1536 * 1024) }); return r.status + ' ' + r.json().error;`);
  expect(big === '413 file exceeds 1 MB' && !onDisk('File Folder/big.bin'), 'and the worker holds to it');
  await setLimit(2, '2');
  expect(await until('a count cap', async () => { const p = (await settings()).prefs; return p.max_files === 2 && p.max_size_mb === 1 && p.who_can_add === 'editors'; }), 'a file count is kept, beside the rest');
  expect(await keeper.until('a full folder', `/Folder is full/.test(document.querySelector('.drop .big').textContent) && /2\\/2 files/.test(document.querySelector('.drop .hint').textContent)`), 'a folder at its count says it is full');
  await keeper.shot('5-full');

  // the folder moves; the files stay where they were
  await keeper.click('.where .move');
  await keeper.until('the prompt', `!!document.querySelector('.framelib-prompt-input')`);
  await keeper.fill('.framelib-prompt-input', 'Shared/Elsewhere');
  await keeper.press('Enter');
  expect(await until('the folder moved', async () => (await settings()).folder === 'Shared/Elsewhere'), 'Change points the session at another folder, kept as its folder setting');
  expect(await keeper.until('the new folder', `document.querySelector('.where .path').textContent === 'Shared/Elsewhere/' && /No files yet/.test(document.querySelector('main').textContent)`), 'and the page shows it, empty');
  expect(await visitor.until('the stranger to move too', `document.querySelector('.where .path')?.textContent === 'Shared/Elsewhere/' && document.querySelectorAll('.file').length === 0`), "and the stranger's page follows");
  expect(onDisk('File Folder/sample.bin') && onDisk('File Folder/dropped notes.txt'), 'the old folder keeps its files');
  await keeper.shot('6-moved');
};

function onSaved(dir, name) {
  try { return readFileSync(join(dir, name)); } catch { return null; }
}
