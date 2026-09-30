// Gift List in the viewer: the keeper choosing a list, wishing and claiming; a stranger reading, and shown no claim.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const LIST = 'christmas.wishes';
  const enter = (b) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, b.child);
  const put = (b, selector, text) => b.inFrame(`const el = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  // The one element of `selector` whose words match, named so a real click can find it.
  const named = async (b, selector, words, name) => (await b.inFrame(`
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${words}.test(e.textContent));
    if (el) el.setAttribute('data-check', ${JSON.stringify(name)});
    return !!el;`)) ? `[data-check="${name}"]` : `${selector}[data-nothing-matched]`;
  const wish = (b, item) => named(b, '.wish', new RegExp(item), item);
  const add = async (item, who) => {
    await keeper.fill('.add .f-item', item);
    await put(keeper, '.add .f-for', who);
    await keeper.click('.add .f-item');
    await enter(keeper);
  };
  const leaked = (r) => r.some((x) => x.cells.claimed_by !== '' || x.cells.claimed_by_id !== '');

  // ---- an editor is asked which list, the first time
  if (!await keeper.until('the chooser to draw', `!!document.querySelector('.framelib-choose-opt')`)) return;
  expect(await keeper.inFrame(`return document.querySelectorAll('.framelib-choose-opt').length === 1 && /New list/.test(document.querySelector('.framelib-choose-opt').textContent)`), 'a space with no wish list offers a new one');
  expect(await keeper.inFrame(`return document.styleSheets.length >= 2 && getComputedStyle(document.querySelector('main')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-choose');
  await keeper.click('.framelib-choose-opt');
  await keeper.until('the name to be asked', `!!document.querySelector('.framelib-prompt-input')`);
  await keeper.fill('.framelib-prompt-input', 'Christmas');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  expect(await keeper.until('the list to be named', `/list: christmas/.test(document.querySelector('.which')?.textContent ?? '')`), 'the keeper names a list and the page is bound to it');
  expect(await keeper.until('the empty list', `/No wishes yet\\. Add the first one above\\./.test(document.body.innerText)`), 'which is empty');
  await keeper.shot('2-empty');

  // ---- wishes
  await keeper.click('.add .f-item');
  await enter(keeper);
  await sleep(400);
  expect((await rows(LIST)).length === 0, 'Enter with nothing typed adds nothing');
  await add('Teapot', 'Gran');
  const teapot = await untilRows('the wish', LIST, (r) => r.find((x) => x.cells.item === 'Teapot'));
  expect(teapot && teapot.cells.for_who === 'Gran' && teapot.cells.for_user_id === '' && teapot.cells.claimed === 0
    && teapot.cells.url === '' && teapot.cells.notes === '' && teapot.cells.claimed_by === '' && teapot.cells.claimed_by_id === ''
    && teapot.cells.added_ms > 0 && teapot.cells._created_at > 0 && teapot.cells._modified_at > 0, 'a wish is a row of the list, stamped when it was made');
  expect(await keeper.until('the wish to draw', `[...document.querySelectorAll('.list')].some((l) => l.querySelector('.l-name').textContent === 'Gran' && /Teapot/.test(l.textContent))`), "and is drawn on Gran's list, from the answer");
  expect(await keeper.inFrame(`return document.querySelector('.add .f-item').value === '' && document.querySelector('.add .f-for').value === 'Gran'`), 'the strip keeps who it is for');
  await add('Socks', '');
  const socks = await untilRows('a wish of their own', LIST, (r) => r.find((x) => x.cells.item === 'Socks'));
  expect(socks && socks.cells.for_user_id.startsWith('did:'), 'a wish with no name is for whoever adds it');
  expect(await keeper.until('their own list', `/Socks/.test(document.querySelector('.list.mine')?.textContent ?? '') && !!document.querySelector('.list.mine .kept')`), 'drawn as their list, with the note on what is hidden');
  expect(await keeper.inFrame(`return !document.querySelector('.list.mine .claim') && !document.querySelector('.list.mine .tag')`), 'where nothing is offered to claim');

  // ---- a stranger at the published address
  const visitor = await open();
  if (!await visitor.until('the list to draw', `/Teapot/.test(document.querySelector('.lists')?.textContent ?? '')`)) return;
  expect(await visitor.inFrame(`return /You are looking at this list\\./.test(document.querySelector('.banner').textContent) && !document.querySelector('.add') && !document.querySelector('.which button') && !document.querySelector('.trash') && !document.querySelector('.framelib-dialog-host')`), 'a stranger reads the list and is offered no way to change it');
  expect(await visitor.inFrame(`return getComputedStyle(document.querySelector('.claim')).display === 'none' && !document.querySelector('.list.mine')`), 'nor to claim from it');

  // ---- a claim
  await keeper.click(`${await wish(keeper, 'Teapot')} .claim`);
  const claimed = await untilRows('the claim', LIST, (r) => r.find((x) => x.cells.item === 'Teapot' && x.cells.claimed === 1));
  expect(claimed && claimed.cells.for_who === 'Gran' && claimed.cells.added_ms === teapot.cells.added_ms && claimed.cells._created_at === teapot.cells._created_at, 'a claim is marked on the row, which kept what it held');
  expect(!leaked(await rows(LIST)), 'and the table never says who');
  expect(await keeper.until('the tag', `/you/.test(document.querySelector('.wish.taken button.tag')?.textContent ?? '')`), 'the keeper sees the tag as theirs');
  await keeper.shot('3-claimed');
  // a stranger may be the one the gift is for: their page is told the list changed and shows no claim
  await sleep(800);
  expect(await visitor.inFrame(`return /Teapot/.test(document.querySelector('.lists').textContent) && !document.querySelector('.tag')`), 'the stranger is shown nothing of the claim');
  await visitor.shot('4-stranger');

  await keeper.click('.wish.taken button.tag');
  expect(await untilRows('the release', LIST, (r) => r.find((x) => x.cells.item === 'Teapot' && x.cells.claimed === 0)), 'the holder lets a claim go');
  expect(await keeper.until('the offer again', `!document.querySelector('.tag') && !!document.querySelector('.claim')`), 'and it can be claimed again');

  // ---- removing takes two presses
  await add('Book', 'Gran');
  await untilRows('a second wish', LIST, (r) => r.find((x) => x.cells.item === 'Book'));
  await keeper.until('the second wish', `/Book/.test(document.querySelector('.lists').textContent)`);
  const book = `${await wish(keeper, 'Book')} .trash`;
  await keeper.click(book);
  await sleep(300);
  expect((await rows(LIST)).some((x) => x.cells.item === 'Book') && await keeper.inFrame(`return !!document.querySelector('.trash.armed')`), 'one press arms Remove and removes nothing');
  await keeper.click(book);
  expect(await untilRows('the wish to go', LIST, (r) => !r.some((x) => x.cells.item === 'Book')), 'a second removes the wish');
  expect(await visitor.until('the wish to go there too', `!/Book/.test(document.querySelector('.lists').textContent)`), 'for the stranger as well');

  // ---- another list, holding a row claimed by nobody known
  await seed('wishes', 'old1', { item: 'Kettle', for_who: 'Gran', for_user_id: '', url: '', notes: 'a quiet one', claimed_by: '', claimed_by_id: '', added_ms: 5, claimed: 1, _created_at: 5, _modified_at: 5 });
  await keeper.click('.which button');
  await keeper.until('the chooser again', `document.querySelectorAll('.framelib-choose-opt').length >= 2`);
  expect(await keeper.inFrame(`const o = [...document.querySelectorAll('.framelib-choose-opt')].map((e) => [...e.children].map((c) => c.textContent.trim()).join(' | '));
    return o.length === 3 && o[0] === 'christmas | 2 wishes' && o[1] === 'wishes | 1 wish' && /^New list/.test(o[2]);`), "the chooser lists the space's wish lists and how much each holds");
  await keeper.shot('5-lists');
  await keeper.click(await named(keeper, '.framelib-choose-opt', /^\s*wishes/, 'plain'));
  expect(await keeper.until('the other list', `/list: wishes/.test(document.querySelector('.which').textContent) && /Kettle/.test(document.querySelector('.lists')?.textContent ?? '')`), 'the keeper changes list and the old row is read');
  expect(await keeper.inFrame(`return /a quiet one/.test(document.querySelector('.w-note').textContent) && /claimed/.test(document.querySelector('button.tag').textContent)`), 'claimed, by someone no longer known');
  expect(await visitor.until('the other list there', `/Kettle/.test(document.querySelector('.lists')?.textContent ?? '')`), 'the stranger follows to it');
  expect(await visitor.inFrame(`return !document.querySelector('.tag')`), 'and is shown nothing of its claim');
  await keeper.click('button.tag');
  await keeper.until('the question', `/Let it go/.test(document.querySelector('.framelib-dialog-host .framelib-btn-primary')?.textContent ?? '')`);
  await keeper.shot('6-release');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  const old = await untilRows('the old claim to go', 'wishes', (r) => r.find((x) => x.id === 'old1' && x.cells.claimed === 0));
  expect(old && old.cells.item === 'Kettle' && old.cells.notes === 'a quiet one' && old.cells._created_at === 5, 'an editor lets it go, over the row as it was');
  expect((await rows(LIST)).length === 2, 'and the first list holds what it held');
  await keeper.shot('7-end');
};
