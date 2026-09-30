// Bookmarks in the viewer: the keeper saves by hand and by pasting, renames, tags, notes,
// searches, filters, opens and deletes; a stranger at the published address reads the same
// links live and has nothing to change.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = `(document.getElementById('app')?.textContent ?? '')`;
  const titles = `[...document.querySelectorAll('.row .r-title')].map((e) => e.textContent)`;
  // Mark the act button of the row whose title matches, so a selector can name it.
  const mark = (b, re, nth) => b.inFrame(`
    document.querySelectorAll('[data-t]').forEach((e) => e.removeAttribute('data-t'));
    const r = [...document.querySelectorAll('.row')].find((x) => ${re}.test(x.querySelector('.r-title')?.textContent ?? ''));
    const btn = r?.querySelectorAll('.r-acts .iconbtn')[${nth}];
    if (btn) btn.setAttribute('data-t', '1');
    return !!btn;`);
  const pick = (b, label) => b.inFrame(`
    const o = [...document.querySelectorAll('.framelib-choose-opt')].find((e) => e.textContent.includes(${JSON.stringify(label)}));
    if (o) o.setAttribute('data-t', 'opt');
    return !!o;`);
  const answer = async (b, words) => {
    if (!await b.until('the question', `!!document.querySelector('.framelib-prompt-input')`)) return;
    await b.clear('.framelib-prompt-input');
    await b.fill('.framelib-prompt-input', words);
    await b.click('.framelib-dialog-host .framelib-btn-primary');
  };
  // A paste aimed at nothing in particular, the way a person pastes onto the page.
  const paste = (b, words) => b.inFrame(`
    document.activeElement?.blur?.();
    const dt = new DataTransfer();
    dt.setData('text/plain', ${JSON.stringify(words)});
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;`);

  if (!await keeper.until('the page to draw', `!!document.querySelector('main .header')`)) return;
  expect(await keeper.until('an empty list', `/No links yet — paste one anywhere in this frame\\./.test(${text})`), 'the keeper has an empty list and is told to paste');
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && !!document.querySelector('.header .iconbtn') && getComputedStyle(document.querySelector('main')).display === 'flex'`), 'the keeper is the owner with a save button, and the page has its style');
  await keeper.shot('1-empty');

  const visitor = await open();
  if (!await visitor.until('the page to draw', `/Nothing here yet\\./.test(${text})`)) return;
  expect(await visitor.inFrame(`return /You are browsing these links\\./.test(${text}) && !document.querySelector('.header .iconbtn') && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger browses, with no way to save');
  await visitor.shot('2-visitor-empty');

  await keeper.click('.header .iconbtn');
  await answer(keeper, 'not a link');
  expect(await keeper.until('the refusal', `/That didn't look like a web address\\./.test(document.querySelector('.framelib-dialog-host')?.textContent ?? '')`), 'what is not an address is refused, in so many words');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  expect((await rows('_fdata/bookmarks')).length === 0, 'and nothing is saved');

  await keeper.click('.header .iconbtn');
  await answer(keeper, 'example.org/posts/how-to_brew-coffee.html');
  const brew = await untilRows('the link', '_fdata/bookmarks', (r) => r.find((x) => x.cells.url === 'https://example.org/posts/how-to_brew-coffee.html'));
  expect(brew?.cells.title === 'How to brew coffee' && brew?.cells.domain === 'example.org' && brew?.cells.tags === '' && brew?.cells.note === '' && brew?.cells.added_ms > 0 && brew?.cells._created_at > 0, 'a link typed in is a row of the space, named from its address');
  expect(await keeper.until('the link to draw', `${titles}[0] === 'How to brew coffee' && document.querySelector('.row .dom').textContent === 'example.org'`), 'and drawn with its site');
  expect(await visitor.until('the link to arrive by itself', `${titles}[0] === 'How to brew coffee'`), "the stranger's open page is told of it");

  await paste(keeper, 'https://news.example.net/item/12345');
  const news = await untilRows('the pasted link', '_fdata/bookmarks', (r) => r.find((x) => x.cells.domain === 'news.example.net'));
  expect(news?.cells.title === 'news.example.net', 'a link pasted onto the page saves itself');
  expect(await keeper.until('the row to land', `${titles}[0] === 'news.example.net' && !!document.querySelector('.row.landed')`), 'and the row it made says so');
  await paste(keeper, 'just some words');
  await sleep(400);
  expect((await rows('_fdata/bookmarks')).length === 2, 'a paste that is not a link saves nothing');
  await paste(keeper, 'https://example.org/posts/how-to_brew-coffee.html');
  await sleep(600);
  expect((await rows('_fdata/bookmarks')).length === 2, 'the same link pasted again is not saved twice');
  await keeper.shot('3-two-links');

  await mark(keeper, /brew/, 0);
  await keeper.click('[data-t]');
  if (!await keeper.until('the choices', `document.querySelectorAll('.framelib-choose-opt').length === 4`)) return;
  await pick(keeper, 'Tags');
  await keeper.click('[data-t="opt"]');
  await answer(keeper, '#Coffee, kitchen');
  expect(await untilRows('the tags', '_fdata/bookmarks', (r) => r.find((x) => x.id === brew?.id && x.cells.tags === 'coffee,kitchen')), 'tags are kept on the row, cleaned');
  expect(await keeper.until('the tag bar', `[...document.querySelectorAll('button.tag')].map((t) => t.textContent).join(' ') === 'coffee kitchen'`), 'every tag is offered as a filter');

  await mark(keeper, /brew/, 0);
  await keeper.click('[data-t]');
  await keeper.until('the choices', `document.querySelectorAll('.framelib-choose-opt').length === 4`);
  await pick(keeper, 'Rename');
  await keeper.click('[data-t="opt"]');
  await answer(keeper, 'Brewing guide');
  await mark(keeper, /Brewing/, 0);
  await keeper.click('[data-t]');
  await keeper.until('the choices', `document.querySelectorAll('.framelib-choose-opt').length === 4`);
  await pick(keeper, 'Note');
  await keeper.click('[data-t="opt"]');
  await answer(keeper, 'the pour-over one');
  const edited = await untilRows('the edit', '_fdata/bookmarks', (r) => r.find((x) => x.id === brew?.id && x.cells.title === 'Brewing guide' && x.cells.note === 'the pour-over one'));
  expect(edited?.cells.tags === 'coffee,kitchen' && edited?.cells.url === brew?.cells.url && edited?.cells.added_ms === brew?.cells.added_ms && edited?.cells._created_at === brew?.cells._created_at, 'a rename and a note land over what the row held');
  expect(await keeper.until('the edit to draw', `${titles}.includes('Brewing guide') && /the pour-over one/.test(${text})`), 'and the page shows them');
  expect(await visitor.until('the edit to reach the stranger', `${titles}.includes('Brewing guide') && [...document.querySelectorAll('button.tag')].length === 2`), 'and so does the stranger');
  await keeper.shot('4-edited');

  await keeper.fill('.search input', 'pour-over');
  expect(await keeper.until('the search', `${titles}.length === 1 && ${titles}[0] === 'Brewing guide'`), 'search finds a link by its note');
  await keeper.clear('.search input');
  await keeper.fill('.search input', 'nothing like it');
  expect(await keeper.until('no match', `/Nothing matches\\./.test(${text})`), 'and says when nothing matches');
  await keeper.click('.search .clear');
  expect(await keeper.until('the search to clear', `${titles}.length === 2`), 'clearing the search shows everything');
  await keeper.inFrame(`[...document.querySelectorAll('button.tag')].find((t) => t.textContent === 'kitchen').setAttribute('data-t', 'tag'); return true;`);
  await keeper.click('button.tag[data-t="tag"]');
  expect(await keeper.until('the filter', `${titles}.length === 1 && ${titles}[0] === 'Brewing guide'`), 'a tag filters the list');
  await keeper.click('button.tag.active');
  expect(await keeper.until('the filter to lift', `${titles}.length === 2`), 'and clicking it again lifts the filter');

  // The viewer opens the link; stand in for the tab it would open.
  await keeper.evaluate(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; return true;`);
  await keeper.inFrame(`[...document.querySelectorAll('.row .r-title')].find((e) => e.textContent === 'Brewing guide').setAttribute('data-t', 'go'); return true;`);
  await keeper.click('[data-t="go"]');
  await sleep(300);
  expect(await keeper.evaluate(`return window.__opened.join(' ');`) === 'https://example.org/posts/how-to_brew-coffee.html', 'a title opens its link');

  await mark(keeper, /news/, 1);
  await keeper.click('[data-t]');
  expect(await keeper.inFrame(`return document.querySelector('[data-t]')?.classList.contains('armed')`), 'the first press arms delete');
  expect((await rows('_fdata/bookmarks')).length === 2, 'and deletes nothing yet');
  await keeper.click('[data-t]');
  expect(await untilRows('the delete', '_fdata/bookmarks', (r) => r.length === 1 && r[0].id === brew?.id), 'the second press deletes the row');
  expect(await visitor.until('the delete to reach the stranger', `${titles}.length === 1`), "and the stranger's page follows");
  await keeper.shot('5-after-delete');

  await seed('_fdata/bookmarks', 'old1', { url: 'https://example.com/old-guide', title: 'Old guide', domain: 'example.com', note: '', tags: 'docs', added_ms: Date.now() - 3 * 86400000, added_by: 'Ana', _created_at: 5, _modified_at: 5 });
  await visitor.send('Page.reload');
  visitor.child = null;
  for (let i = 0; i < 60 && !visitor.child; i++) await sleep(250);
  expect(await visitor.until('the old link', `${titles}.includes('Old guide')`), 'a link already in the table is read');
  expect(await visitor.inFrame(`return !document.querySelector('.r-acts') && !document.querySelector('.hint') && /3d/.test(${text})`), 'with its age, and the stranger has nothing to change');
  await visitor.shot('6-visitor');
};
