// Community Library in the viewer: the keeper lending and taking back, a stranger at the
// published address shown what is in and what is out.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const q = JSON.stringify;
  // a setting is the session's own: read it back through the frame
  const viaFrame = async (path, test) => {
    for (let i = 0; i < 60; i++) {
      const v = await keeper.inFrame(`const r = await window.seamside.fetch(${JSON.stringify(path)}); return r.ok ? r.json() : null;`);
      if (v && test(v)) return v;
      await sleep(250);
    }
    return null;
  };
  const choose = (b, selector, value) => b.inFrame(`
    const s = document.querySelector(${q(selector)});
    s.value = ${q(String(value))};
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  // the row of the item named, tagged so a click can find it
  const item = async (b, name) => {
    await b.inFrame(`
      for (const el of document.querySelectorAll('.asset')) {
        if (el.querySelector('.asset-name').textContent === ${q(name)}) el.id = 'the-item'; else el.removeAttribute('id');
      }
      return true;`);
    return '#the-item';
  };
  const text = (b, selector) => b.inFrame(`return document.querySelector(${q(selector)})?.innerText ?? '';`);
  const asset = (list, name) => list.find((x) => x.cells.name === name);

  // ----- the list of members: none yet, then the one the space holds
  if (!await keeper.until('the library to draw', `!!document.querySelector('.page-header h1')`)) return;
  expect(await keeper.until('the question of which list', `/There is no members list in this space yet/.test(document.querySelector('.framelib-modal')?.innerText ?? '')`), 'an editor with no list chosen is asked for one');
  await keeper.shot('1-which-list');
  await keeper.click('.framelib-modal-actions .framelib-btn-ghost');
  expect(await keeper.until('the line to say none', `/Members list: none yet/.test(document.querySelector('.list-line')?.innerText ?? '')`), 'put off, the page says no list is chosen');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.compose')).display === 'grid' && !!document.querySelector('.empty')`), 'the page has its style, and an empty library');

  await seed('members', 'm1', { name: 'Ada Lovelace', role: 'Member' });
  await keeper.click('.list-line__change');
  expect(await keeper.until('the list to be offered', `/members\\.table\\.jsonl · 1 person/.test(document.querySelector('.framelib-choose-opt')?.innerText ?? '')`), "the space's members list is offered, with how many it holds");
  await keeper.shot('2-lists');
  await keeper.click('.framelib-choose-opt');
  expect(await keeper.until('the line to name it', `/Members list: members/.test(document.querySelector('.list-line')?.innerText ?? '') && /Change/.test(document.querySelector('.list-line__change').textContent)`), 'the list chosen is the list in use');

  // ----- adding
  await keeper.click('.compose button');
  await sleep(400);
  expect((await rows('library_assets')).length === 0, 'an item with no name is not added');
  await keeper.fill('.compose input', 'Ladder');
  await choose(keeper, '.compose select', 'Tool');
  await keeper.click('.compose button');
  const ladder = await untilRows('the ladder', 'library_assets', (r) => asset(r, 'Ladder'));
  expect(ladder?.cells.item_type === 'Tool' && ladder?.cells.needs_attention === 0 && ladder?.cells._created_at > 0 && ladder?.cells._modified_at > 0, 'an item added is a row of the space, in the shape installed copies hold');
  expect(await keeper.until('the ladder to list', `document.querySelector('.asset-name')?.textContent === 'Ladder' && document.querySelector('.compose input').value === ''`), 'and is listed from the answer, the field cleared');
  await keeper.fill('.compose input', 'Atlas');
  await choose(keeper, '.compose select', 'Book');
  await keeper.inFrame(`document.querySelector('.compose input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
  expect(await untilRows('the atlas', 'library_assets', (r) => asset(r, 'Atlas')?.cells.item_type === 'Book'), 'Enter adds one too');
  expect(await keeper.until('the count', `/^2\\s*items$/.test(document.querySelector('.airhero')?.innerText.trim() ?? '')`), 'the page counts two items');
  await keeper.shot('3-items');

  // ----- out to a member, and back
  await keeper.click(`${await item(keeper, 'Ladder')} button[title="Check out"]`);
  expect(await keeper.until('the roster in the dialog', `/Ada Lovelace · Member/.test(document.querySelector('.dialog select')?.innerText ?? '')`), 'the dialog offers the people on the list');
  await choose(keeper, '.dialog .field:last-of-type select', 14);
  await keeper.shot('4-check-out');
  await keeper.click('.dialog-actions button:last-child');
  const out = await untilRows('the loan', 'library_assets', (r) => r.find((x) => x.cells.checked_out_member_id === 'm1'));
  expect(out?.cells.name === 'Ladder' && out?.cells.borrow_days === 14 && out?.cells.checked_out_manual_name === '' && out?.cells.checked_out_at > 0 && out?.cells.item_type === 'Tool', 'a loan is kept over the row as it was');
  expect(await keeper.until('the borrower to show', `document.querySelector('.meta-borrower')?.textContent === 'Ada Lovelace' && /out · due/.test(document.querySelector('.status-chip.status-checked_out')?.innerText ?? '') && !document.querySelector('.dialog')`), 'the page names the borrower and says when it is due');
  await keeper.click(`${await item(keeper, 'Ladder')} button[title="Check in"]`);
  expect(await untilRows('the return', 'library_assets', (r) => asset(r, 'Ladder')?.cells.checked_out_at === null && asset(r, 'Ladder')?.cells.checked_out_member_id === ''), 'checked in, the loan is cleared');
  expect(await keeper.until('the shelf', `!document.querySelector('.meta-borrower') && document.querySelectorAll('.status-chip.status-available').length === 2`), 'and both are in the library');

  // ----- out to somebody by name
  await keeper.click(`${await item(keeper, 'Atlas')} button[title="Check out"]`);
  await keeper.until('the dialog', `!!document.querySelector('.dialog .seg-toggle')`);
  await keeper.click('.dialog .seg-btn:nth-child(2)');
  await keeper.click('.dialog-actions button:last-child');
  expect(await keeper.until('to be asked for a name', `/Enter a name or email/.test(document.querySelector('.framelib-modal')?.innerText ?? '')`), 'nobody named, nothing is lent');
  await keeper.click('.framelib-modal-actions .framelib-btn-primary');
  await keeper.fill('.dialog input[type="text"]', 'Pat');
  await keeper.click('.dialog-actions button:last-child');
  expect(await untilRows('the loan by name', 'library_assets', (r) => asset(r, 'Atlas')?.cells.checked_out_manual_name === 'Pat' && asset(r, 'Atlas')?.cells.borrow_days === 7), 'a loan by name runs the default time');

  // ----- a flag, an edit
  await keeper.click(`${await item(keeper, 'Ladder')} button[title="Flag for attention"]`);
  await keeper.fill('.dialog textarea', 'rung bent');
  await keeper.click('.dialog-actions button:last-child');
  expect(await untilRows('the flag', 'library_assets', (r) => asset(r, 'Ladder')?.cells.needs_attention === 1 && asset(r, 'Ladder')?.cells.notes === 'rung bent'), 'a flag is kept with what is wrong');
  expect(await keeper.until('the chip', `/needs attention/.test(document.querySelector('.status-chip.status-issue')?.innerText ?? '') && /rung bent/.test(document.querySelector('.asset-notes')?.innerText ?? '')`), 'and shown');
  await keeper.click(`${await item(keeper, 'Ladder')} button[title="Edit"]`);
  await keeper.fill('.dialog input[type="text"]', 'Tall ladder');
  await keeper.click('.dialog-actions button:last-child');
  const tall = await untilRows('the new name', 'library_assets', (r) => asset(r, 'Tall ladder'));
  expect(tall?.id === ladder?.id && tall?.cells.needs_attention === 1 && tall?.cells.notes === 'rung bent' && tall?.cells._created_at === ladder?.cells._created_at, 'an edit changes the item and keeps the rest');

  // ----- the owner's settings
  await keeper.click('.header-actions button');
  await keeper.until('the settings', `/Library settings/.test(document.querySelector('.dialog h2')?.textContent ?? '')`);
  await keeper.shot('5-settings');
  await keeper.fill('.dialog input[type="text"]', 'Tool Shed');
  await keeper.click('.dialog-actions button:last-child');
  const kept = (await viaFrame('/api/state', (s) => s.prefs?.org_name === 'Tool Shed'))?.prefs ?? {};
  expect(kept.org_name === 'Tool Shed' && kept.item_types?.length === 5 && kept.borrow_options?.length === 4 && kept.default_borrow_days === 7 && kept.owner_only_edit === false, 'the settings are kept');
  expect(await keeper.until('the name', `document.querySelector('.page-header h1').textContent === 'Tool Shed' && !document.querySelector('.dialog')`), 'and the page takes the new name');
  await keeper.shot('6-library');

  // ----- a stranger at the published address
  const visitor = await open();
  if (!await visitor.until('the public list', `document.querySelectorAll('.public-row').length === 2`)) return;
  const seen = await visitor.inFrame(`return document.body.innerText;`);
  expect(/Tool Shed/.test(seen) && /Atlas/.test(seen) && /Book · checked out · due/.test(seen) && /Tall ladder/.test(seen) && /Tool · unavailable/.test(seen), 'a stranger is shown what is in and what is out');
  expect(!/Pat|rung bent|Ada|Members list/.test(seen), 'and nobody, no note and no list');
  expect(await visitor.inFrame(`return !document.querySelector('.compose') && !document.querySelector('.asset-actions') && !document.querySelector('.header-actions button') && !document.querySelector('.framelib-modal')`), 'with nothing to change it by');
  expect(await visitor.inFrame(`return getComputedStyle(document.querySelector('.public-row')).display !== 'inline'`), "the stranger's page has its style");
  await visitor.shot('7-stranger');

  // nobody touches the stranger's page: the push brings the change to it
  await keeper.fill('.compose input', 'Saw');
  await choose(keeper, '.compose select', 'Tool');
  await keeper.click('.compose button');
  await untilRows('the saw', 'library_assets', (r) => asset(r, 'Saw'));
  expect(await visitor.until('the saw to arrive by itself', `[...document.querySelectorAll('.public-name')].some((n) => n.textContent === 'Saw')`), "a stranger's open page is told to read again");
  expect(/Saw/.test(await text(keeper, '#list-wrap')), "and the keeper's lists it");

  await keeper.click(`${await item(keeper, 'Saw')} button[title="Edit"]`);
  await keeper.until('the edit dialog', `!!document.querySelector('.dialog .danger')`);
  await keeper.click('.dialog .danger');
  expect(await keeper.until('to be asked', `/Delete "Saw"\\?/.test(document.querySelector('.framelib-modal')?.innerText ?? '')`), 'a delete is asked about');
  await keeper.click('.framelib-modal-actions .framelib-btn-danger');
  expect(await untilRows('the saw to go', 'library_assets', (r) => r.length === 2 && !asset(r, 'Saw')), 'and the item goes');
  expect(await visitor.until('the saw to leave', `document.querySelectorAll('.public-row').length === 2`), 'from the page of whoever was looking');
  expect((await text(visitor, '.airhero')).replace(/\s+/g, ' ').trim() === '2 items · 1 out · 1 needs attention', 'which counts what it is shown');
  await visitor.shot('8-stranger-after');
};
