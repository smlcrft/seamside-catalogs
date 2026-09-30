// Notes in the viewer: the keeper captures, tags, pins, edits and deletes; a stranger at
// the published address reads the same stream live and has nothing to change.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = `(document.getElementById('app')?.textContent ?? '')`;
  const bodies = `[...document.querySelectorAll('.note .n-body')].map((e) => e.textContent)`;
  // Mark the act button of the note whose body matches, so a selector can name it.
  const mark = (b, re, nth) => b.inFrame(`
    document.querySelectorAll('[data-t]').forEach((e) => e.removeAttribute('data-t'));
    const n = [...document.querySelectorAll('.note')].find((x) => ${re}.test(x.querySelector('.n-body')?.textContent ?? ''));
    const btn = n?.querySelectorAll('.n-acts .iconbtn')[${nth}];
    if (btn) btn.setAttribute('data-t', '1');
    return !!btn;`);
  const post = async (b, words) => {
    await b.fill('.composer textarea', words);
    await b.click('.composer .btn-primary');
  };

  if (!await keeper.until('the stream to draw', `!!document.querySelector('main .composer textarea')`)) return;
  expect(await keeper.until('an empty stream', `/Nothing yet\\. The box above is waiting\\./.test(${text})`), 'the keeper has the composer and an empty stream');
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && getComputedStyle(document.querySelector('main')).display === 'flex'`), 'the keeper is the owner, and the page has its style');
  expect(await keeper.inFrame(`return document.querySelector('.composer .btn-primary').disabled`), 'post waits for something to post');
  await keeper.shot('1-empty');

  const visitor = await open();
  if (!await visitor.until('the stream to draw', `/Nothing here yet\\./.test(${text})`)) return;
  expect(await visitor.inFrame(`return !document.querySelector('.composer') && /You are reading these notes\\./.test(${text}) && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger reads, with no composer');
  await visitor.shot('2-visitor-empty');

  await post(keeper, 'Buy milk #Home #errands.');
  const milk = await untilRows('the note', '_fdata/notes', (r) => r.find((x) => x.cells.body === 'Buy milk #Home #errands.'));
  expect(milk?.cells.tags === 'home,errands' && milk?.cells.pinned === 0 && milk?.cells.edited_ms === 0 && milk?.cells.created_ms > 0 && milk?.cells._created_at > 0, 'a posted note is a row of the space, tags derived from its body');
  expect(await keeper.until('the note to draw', `${bodies}[0] === 'Buy milk #Home #errands.' && !!document.querySelector('.n-body .hash')`), 'and drawn, its tags in the channel colour');
  expect(await keeper.inFrame(`return document.querySelector('.composer textarea').value === ''`), 'the composer is emptied for the next thought');
  expect(await visitor.until('the note to arrive by itself', `${bodies}[0] === 'Buy milk #Home #errands.'`), "the stranger's open page is told of it");

  await keeper.fill('.composer textarea', 'Call the plumber #work');
  await keeper.press('Enter');
  await sleep(400);
  expect((await rows('_fdata/notes')).length === 1, 'Enter alone posts nothing: it is a new line');
  await keeper.click('.composer .btn-primary');
  await untilRows('the second note', '_fdata/notes', (r) => r.find((x) => x.cells.body === 'Call the plumber #work'));
  expect(await keeper.until('the tag bar', `[...document.querySelectorAll('button.tag')].map((t) => t.textContent).join(' ') === '#errands #home #work'`), 'every tag is offered as a filter');
  await keeper.shot('3-two-notes');

  await keeper.inFrame(`[...document.querySelectorAll('button.tag')].find((t) => t.textContent === '#work').setAttribute('data-t', 'tag'); return true;`);
  await keeper.click('button.tag[data-t="tag"]');
  expect(await keeper.until('the filter', `${bodies}.length === 1 && /plumber/.test(${bodies}[0])`), 'a tag filters the stream');
  await keeper.click('button.tag.active');
  expect(await keeper.until('the filter to lift', `${bodies}.length === 2`), 'and clicking it again lifts the filter');

  await mark(keeper, /milk/, 0);
  await keeper.click('[data-t]');
  expect(await untilRows('the pin', '_fdata/notes', (r) => r.find((x) => x.cells.body === 'Buy milk #Home #errands.' && x.cells.pinned === 1)), 'a pin is kept on the row');
  const pinned = await rows('_fdata/notes').then((r) => r.find((x) => x.id === milk?.id));
  expect(pinned?.cells.tags === 'home,errands' && pinned?.cells.created_ms === milk?.cells.created_ms && pinned?.cells._created_at === milk?.cells._created_at, 'over what the row held');
  expect(await keeper.until('the pinned group', `document.querySelector('.stream .day')?.textContent === 'pinned' && document.querySelector('.note.pinned .n-body')?.textContent === 'Buy milk #Home #errands.'`), 'the pinned note is lifted to the top');
  expect(await visitor.until('the pin to reach the stranger', `!!document.querySelector('.note.pinned')`), 'and the stranger sees it pinned');

  await mark(keeper, /milk/, 1);
  await keeper.click('[data-t]');
  if (!await keeper.until('the editor', `!!document.querySelector('.edit-area')`)) return;
  await keeper.clear('.edit-area');
  await keeper.fill('.edit-area', 'Buy oat milk #shopping');
  await keeper.shot('4-editing');
  await keeper.click('.edit-foot .btn-primary');
  const edited = await untilRows('the edit', '_fdata/notes', (r) => r.find((x) => x.cells.body === 'Buy oat milk #shopping'));
  expect(edited?.id === milk?.id && edited?.cells.tags === 'shopping' && edited?.cells.edited_ms > 0 && edited?.cells.pinned === 1, 'an edit re-derives the tags and keeps the pin');
  expect(await keeper.until('the edit to draw', `/edited/.test(document.querySelector('.note.pinned .n-meta')?.textContent ?? '') && ![...document.querySelectorAll('button.tag')].some((t) => t.textContent === '#home')`), 'the note says it was edited, and the old tags are gone');

  await mark(keeper, /plumber/, 2);
  await keeper.click('[data-t]');
  expect(await keeper.inFrame(`return document.querySelector('[data-t]')?.classList.contains('armed')`), 'the first press arms delete');
  expect((await rows('_fdata/notes')).length === 2, 'and deletes nothing yet');
  await keeper.click('[data-t]');
  expect(await untilRows('the delete', '_fdata/notes', (r) => r.length === 1 && r[0].id === milk?.id), 'the second press deletes the row');
  expect(await visitor.until('the delete to reach the stranger', `${bodies}.length === 1`), "and the stranger's page follows");
  await keeper.shot('5-after-delete');

  await seed('_fdata/notes', 'old1', { body: 'An old thought #Idea', tags: 'idea', author_name: 'Collaborator', author_id: 'did:dht:x', created_ms: Date.now() - 3 * 86400000, edited_ms: 0, pinned: 0, _created_at: 5, _modified_at: 5 });
  await visitor.send('Page.reload');
  visitor.child = null;
  for (let i = 0; i < 60 && !visitor.child; i++) await sleep(250);
  expect(await visitor.until('the old note', `${bodies}.includes('An old thought #Idea')`), 'a note already in the frame data is read');
  expect(await visitor.inFrame(`return [...document.querySelectorAll('.stream .day')].length === 2 && /Collaborator/.test(${text})`), 'under its own day, and by name once two people have written');
  await visitor.shot('6-visitor');
};
