// Outpost in the viewer: the keeper posts, polls, attaches a picture and a file, sets the
// board up and deletes; a stranger at the published address reads it live, signs in, votes.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'outpost-'));
  const picture = join(dir, 'tiles.png');
  writeFileSync(picture, png(48, 32, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [200, 60, 40] : [40, 90, 200]));
  const notes = join(dir, 'notes.bin');
  writeFileSync(notes, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 13 + (i >> 7)) & 0xff)));
  const saved = join(dir, 'saved');
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const root = `document.querySelector('main')?.textContent ?? ''`;
  const first = '.feed .post:first-child';

  if (!await keeper.until('the board to draw', `!!document.querySelector('main .header')`)) return;
  expect(await keeper.until('an empty board', `/Nothing posted yet — share the first thing above\\./.test(${root})`), 'the keeper has an empty board and the composer');
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && !!document.querySelector('.gear') && document.querySelector('input.htitle').value === 'Outpost' && getComputedStyle(document.querySelector('.card')).display === 'flex'`), 'as the owner, with the settings gear, the default heading and the page styled');
  expect(await keeper.inFrame(`return document.querySelector('.btn-primary').disabled`), 'Post waits for something to post');
  await keeper.shot('1-empty');

  // a question, typed and posted
  await keeper.click('.kinds-seg button:nth-child(2)');
  await keeper.fill('textarea.compose', 'Is the gate code still 1234? See https://example.com/gate.');
  await keeper.click('.btn-primary');
  const q = await untilRows('the question', 'outpost_posts', (r) => r.find((x) => x.cells.kind === 'question'));
  expect(q?.cells.text === 'Is the gate code still 1234? See https://example.com/gate.' && q?.cells.poll_options === null && q?.cells.author_user_id && q?.cells.created_ms > 0 && q?.cells._created_at && q?.cells._modified_at, 'a post is a row of the space, stamped, by the keeper');
  expect(await keeper.until('the post to draw', `document.querySelector('${first} .body')?.textContent === 'Is the gate code still 1234? See https://example.com/gate.' && document.querySelector('${first} .kindtag').textContent === 'question'`), 'and heads the feed');
  expect(await keeper.inFrame(`return document.querySelector('${first} .body a')?.textContent === 'https://example.com/gate' && document.querySelector('textarea.compose').value === ''`), 'its link is a link, and the composer is empty again');

  // a poll, and the keeper's vote in it
  await keeper.click('.compose-actions .toolbtn:nth-child(2)');
  await keeper.fill('.poll-row:nth-child(1) input', 'Tuesday');
  await keeper.fill('.poll-row:nth-child(2) input', 'Thursday');
  await keeper.click('.addopt');
  await keeper.fill('.poll-row:nth-child(3) input', 'Never');
  await keeper.click('.btn-primary');
  const poll = await untilRows('the poll', 'outpost_posts', (r) => r.find((x) => x.cells.poll_options));
  expect(poll?.cells.poll_options === '["Tuesday","Thursday","Never"]' && poll?.cells.kind === 'thought' && poll?.cells.text === '', 'a poll is kept as its options');
  expect(await keeper.until('the poll to draw', `document.querySelectorAll('${first} .poll .opt').length === 3 && /0 votes · tap to vote/.test(document.querySelector('${first} .poll .tally').textContent)`), 'and drawn, nobody having voted');
  await keeper.click(`${first} .poll .opt:nth-child(2)`);
  const vote = await untilRows('the vote', 'outpost_votes', (r) => r.find((x) => x.cells.post_id === poll?.id));
  expect(vote?.cells.choice === 1 && vote?.id === `${poll?.id}:${vote?.cells.voter}` && vote?.cells.voter.startsWith('u:'), 'a vote is a row keyed by post and voter');
  expect(await keeper.until('the tally', `/1 vote · you voted/.test(document.querySelector('${first} .poll .tally').textContent) && document.querySelector('${first} .poll .opt.chosen .lbl')?.textContent === 'Thursday' && document.querySelector('${first} .poll .opt.chosen .pct').textContent === '100%'`), 'the poll says so');
  await keeper.shot('2-poll');

  // a picture and a file, chosen and posted
  await keeper.fill('textarea.compose', 'Photos from the shed');
  await keeper.choose('input[type="file"]', picture);
  await keeper.choose('input[type="file"]', notes);
  expect(await keeper.until('two pending', `[...document.querySelectorAll('.pending .pill > span')].map((s) => s.textContent).join('|') === 'tiles.png|notes.bin'`), 'both wait in the composer');
  await keeper.click('.btn-primary');
  const media = await untilRows('both attachments', 'outpost_media', (r) => r.length === 2 && r);
  const img = media?.find((m) => m.cells.name === 'tiles.png'), bin = media?.find((m) => m.cells.name === 'notes.bin');
  expect(img?.cells.mime === 'image/png' && img?.cells.size === readFileSync(picture).length && img?.cells.ord === 0 && img?.cells.path === `Outpost/${img?.cells.post_id}/tiles.png`, 'the picture is a row naming its file of the space');
  expect(bin?.cells.ord === 1 && bin?.cells.size === 3000 && bin?.cells.post_id === img?.cells.post_id, 'and the file after it, on the same post');
  expect(await keeper.until('the picture to draw', `document.querySelector('${first} .media img')?.naturalWidth === 48`), 'the picture draws from the bytes the worker hands over');
  expect(await keeper.inFrame(`return document.querySelector('${first} .media .filelink span')?.textContent === 'notes.bin' && document.querySelector('.pending') === null`), 'the file is a link to save, and the composer is empty');
  const back = await keeper.inFrame(`
    const r = await window.seamside.fetch('/api/media/${img?.cells.post_id}/${img?.id}');
    const d = await crypto.subtle.digest('SHA-256', r.bytes());
    return r.type + ' ' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');`);
  expect(back === `image/png ${sha(readFileSync(picture))}`, 'the picture comes back byte for byte');
  await keeper.shot('3-media');

  // the file is saved as it is
  await keeper.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: saved }).catch(() => keeper.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: saved }));
  await keeper.click(`${first} .media .filelink`);
  let got = null;
  for (let i = 0; i < 60 && !got; i++) {
    try { got = existsSync(join(saved, 'notes.bin')) && readdirSync(saved).every((f) => !f.endsWith('.crdownload')) ? readFileSync(join(saved, 'notes.bin')) : null; } catch { /* not yet */ }
    if (!got) await sleep(250);
  }
  expect(got && sha(got) === sha(readFileSync(notes)), 'the file saves byte for byte');

  // the owner sets the board up
  await keeper.click('.gear');
  expect(await keeper.until('the settings', `/Who can post/.test(${root})`), 'the gear opens the settings');
  await keeper.inFrame(`document.querySelector('.card .field input.txt').id = 'op-tagline'; return true;`);
  await keeper.fill('#op-tagline', 'News from the shed');
  await keeper.inFrame(`document.querySelector('#op-tagline').blur(); return true;`);
  expect(await untilRows('the tagline', '__fc_settings', (r) => r.find((x) => x.id === 'outpost_tagline' && x.cells.v === '"News from the shed"')), 'the tagline is kept where installed copies keep it');
  expect(await keeper.until('the tagline to show', `document.querySelector('.header .tagline')?.textContent === 'News from the shed'`), 'and shown under the heading');
  await keeper.fill('input.htitle', 'Shed board');
  await keeper.inFrame(`document.querySelector('input.htitle').blur(); return true;`);
  expect(await untilRows('the heading', '__fc_settings', (r) => r.find((x) => x.id === 'outpost_title' && x.cells.v === '"Shed board"')), 'and so is the heading');
  await keeper.click('.card .seg:not(.kinds-seg) button:nth-child(2)');
  expect(await untilRows('who may post', '__fc_settings', (r) => r.find((x) => x.id === 'outpost_who_can_post' && x.cells.v === '"owner"')), 'Owner only is kept');
  expect(await keeper.until('the choice to hold', `document.querySelector('.card .seg:not(.kinds-seg) button.active')?.textContent.trim() === 'Owner only' && !!document.querySelector('textarea.compose')`), 'and shown, the owner still posting');
  await keeper.shot('4-settings');

  // a stranger at the published address reads the board
  const visitor = await open();
  if (!await visitor.until('the board for a stranger', `document.querySelectorAll('.feed .post').length === 3`)) return;
  expect(await visitor.inFrame(`return document.querySelector('input.htitle').value === 'Shed board' && document.querySelector('input.htitle').disabled && document.querySelector('.header .tagline').textContent === 'News from the shed' && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger sees the heading and tagline, read-only');
  expect(await visitor.inFrame(`return !document.querySelector('textarea.compose') && !document.querySelector('.gear') && !document.querySelector('.iconbtn.del')`), 'with no composer, no settings and nothing to delete');
  expect(await visitor.until('the picture for a stranger', `document.querySelector('.feed .media img')?.naturalWidth === 48`), 'the picture draws for a stranger too');
  const poll2 = `.feed .post:nth-child(2)`;
  expect(await visitor.inFrame(`return [...document.querySelectorAll('${poll2} .poll .opt')].every((b) => b.disabled) && /1 vote$/.test(document.querySelector('${poll2} .poll .tally').textContent.trim()) && !!document.querySelector('${poll2} .poll .votenote.signin')`), 'the poll shows its results, closed to a stranger, with a way to sign in');
  await visitor.shot('5-stranger');

  // the keeper posts; the stranger's open page follows by itself
  await keeper.fill('textarea.compose', 'Gate fixed.');
  await keeper.click('.kinds-seg button:nth-child(4)');
  await keeper.click('.btn-primary');
  expect(await untilRows('the news', 'outpost_posts', (r) => r.find((x) => x.cells.text === 'Gate fixed.' && x.cells.kind === 'announcement')), 'a post of news is kept');
  expect(await visitor.until('the news to arrive', `document.querySelector('.feed .post:first-child .body')?.textContent === 'Gate fixed.' && document.querySelector('.feed .post:first-child .kindtag').textContent === 'news'`), "the stranger's open page is told of it");

  // the stranger signs in and votes
  await visitor.click(`.feed .post:nth-child(3) .poll .votenote.signin`);
  if (await visitor.until('the stranger to be named', `!document.querySelector('.poll .votenote.signin') && !document.querySelector('.feed .post:nth-child(3) .poll .opt').disabled`)) {
    await visitor.click(`.feed .post:nth-child(3) .poll .opt:nth-child(1)`);
    const two = await untilRows('the second vote', 'outpost_votes', (r) => r.filter((x) => x.cells.post_id === poll?.id).length === 2 && r);
    expect(two?.find((x) => x.cells.voter !== vote?.cells.voter)?.cells.choice === 0, 'a stranger who signed in votes, as themselves');
    expect(await visitor.until('their tally', `/2 votes · you voted/.test(document.querySelector('.feed .post:nth-child(3) .poll .tally').textContent)`), 'and sees it counted');
    expect(await keeper.until('the keeper to see it', `/2 votes · you voted/.test(document.querySelector('.feed .post:nth-child(3) .poll .tally').textContent)`), "and the keeper's open page follows");
    await visitor.shot('6-voted');
  }

  // the keeper deletes the post with the attachments: one click arms, the second deletes
  const withMedia = `.feed .post:nth-child(2)`;
  await keeper.click(`${withMedia} .iconbtn.del`);
  expect(await keeper.inFrame(`return document.querySelector('${withMedia} .iconbtn.del').classList.contains('armed')`) && (await rows('outpost_posts')).length === 4, 'the first click only arms');
  await keeper.click(`${withMedia} .iconbtn.del`);
  expect(await untilRows('the post to go', 'outpost_posts', (r) => r.length === 3 && !r.find((x) => x.id === img?.cells.post_id))
    && await untilRows('its media rows to go', 'outpost_media', (r) => r.length === 0 || null), 'the second deletes the post and its attachments');
  expect(await keeper.until('the feed to lose it', `document.querySelectorAll('.feed .post').length === 3 && !document.querySelector('.feed .media')`), 'and the feed loses it');
  expect(await visitor.until('the stranger to lose it', `document.querySelectorAll('.feed .post').length === 3 && !document.querySelector('.feed .media')`), 'for the stranger too');
  await keeper.shot('7-deleted');
};
