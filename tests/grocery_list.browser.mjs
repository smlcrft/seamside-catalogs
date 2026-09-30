// Grocery List in the viewer: the keeper shopping, a Meal Planner's row arriving, a stranger following along.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const row = (name) => `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.txt')?.textContent === ${JSON.stringify(name)})`;
  const mark = (name, part, as) => keeper.inFrame(`${row(name)}.querySelector('${part}').setAttribute('data-check', '${as}'); return true;`);
  const heads = `[...document.querySelectorAll('.group-head')].map((h) => h.textContent).join('|')`;

  if (!await keeper.until('the list to draw', `!!document.querySelector('main .add .f-item')`)) return;
  expect(await keeper.inFrame(`return /Nothing on the list\\. The box above starts it\\./.test(document.querySelector('main').textContent)`), 'the keeper has an empty list and the box to start it');
  expect(await keeper.inFrame(`return !document.querySelector('form') && !document.querySelector('.banner') && document.querySelector('.header .mode').textContent === 'owner'`), 'the page holds no form and no read-only banner, and says owner');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('main')).display === 'flex' && getComputedStyle(document.querySelector('.add')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-empty');

  // an item typed with its quantity and aisle, added on Enter
  await keeper.fill('.add .f-item', 'Milk');
  await keeper.fill('.add .f-qty', '2 L');
  await keeper.fill('.add .f-cat', 'Dairy');
  await keeper.press('Enter');
  const milk = await untilRows('the item', '_fdata/grocery', (r) => r.find((x) => x.cells.item === 'Milk'));
  expect(milk?.cells.quantity === '2 L' && milk?.cells.category === 'dairy' && milk?.cells.checked === 0 && milk?.cells.source === '' && milk?.cells.added_ms > 0 && milk?.cells._created_at && milk?.cells._modified_at, 'Enter adds an item, a row of the space in the contract\'s shape');
  expect(await keeper.until('it to draw', `!!${row('Milk')} && ${heads} === 'dairy'`), 'and the list draws it under its aisle');
  expect(await keeper.inFrame(`return document.querySelector('.f-item').value === '' && document.querySelector('.f-qty').value === '' && document.querySelector('.f-cat').value === 'Dairy'`), 'the item and quantity are cleared and the aisle kept for the next');

  // a second in the same aisle, and one with none
  await keeper.fill('.add .f-item', 'Yoghurt');
  await keeper.press('Enter');
  expect(await untilRows('the second item', '_fdata/grocery', (r) => r.find((x) => x.cells.item === 'Yoghurt' && x.cells.category === 'dairy')), 'the kept aisle goes with the next item');
  await keeper.clear('.add .f-cat');
  await keeper.fill('.add .f-item', 'Batteries');
  await keeper.press('Enter');
  expect(await untilRows('the third item', '_fdata/grocery', (r) => r.find((x) => x.cells.item === 'Batteries' && x.cells.category === '')), 'an item with no aisle has none');
  expect(await keeper.until('the groups', `${heads} === 'dairy|other things'`), 'aisles come first, other things last');
  await keeper.click('.add .f-item');
  await keeper.press('Enter');
  await sleep(400);
  expect((await rows('_fdata/grocery')).length === 3, 'Enter on an empty box adds nothing');

  // a row a Meal Planner inserts arrives by itself, and is an ordinary row here
  await seed('_fdata/grocery', 'mp1', { item: '2 onions', quantity: '', category: 'produce', checked: 0, source: 'recipe_42', added_ms: 7, _created_at: 7, _modified_at: 7 });
  expect(await keeper.until('the planner\'s row', `!!${row('2 onions')}`), "a row another frame wrote reaches the keeper's page");
  expect(await keeper.inFrame(`return ${row('2 onions')}.querySelector('.src')?.title === 'sent from the meal planner' && !${row('Milk')}.querySelector('.src') && ${heads} === 'dairy|produce|other things'`), 'with the provenance dot, in its aisle');
  await keeper.shot('2-list');

  // a click on the name puts it in the cart; the box does too, and takes it out
  await mark('Milk', '.label', 'milk');
  await keeper.click('[data-check="milk"]');
  expect(await untilRows('Milk in the cart', '_fdata/grocery', (r) => r.find((x) => x.id === milk?.id && x.cells.checked === 1 && x.cells.quantity === '2 L' && x.cells._created_at === milk?.cells._created_at)), 'a click on an item checks it off, over the row as it was');
  expect(await keeper.until('the cart', `${row('Milk')}?.classList.contains('checked') && /1 of 4 in the cart/.test(document.querySelector('main').textContent)`), 'and the page draws it bought');
  await mark('2 onions', 'input[type="checkbox"]', 'onions');
  await keeper.click('[data-check="onions"]');
  const onions = await untilRows('the planner\'s row checked', '_fdata/grocery', (r) => r.find((x) => x.id === 'mp1' && x.cells.checked === 1));
  expect(onions?.cells.source === 'recipe_42' && onions?.cells.item === '2 onions' && onions?.cells._created_at === 7, "the planner's row is checked off like any other, its source kept");
  await keeper.click('[data-check="onions"]');
  expect(await untilRows('it unchecked', '_fdata/grocery', (r) => r.find((x) => x.id === 'mp1' && x.cells.checked === 0)), 'and the box takes it out again');
  expect(await keeper.until('the page to follow', `!${row('2 onions')}.classList.contains('checked')`), 'and the page follows');

  // delete asks for a second click
  await mark('Batteries', '.trash', 'trash');
  await keeper.click('[data-check="trash"]');
  expect(await keeper.until('the arming', `!!document.querySelector('[data-check="trash"].armed')`), 'one click on delete arms it');
  await sleep(300);
  expect((await rows('_fdata/grocery')).some((x) => x.cells.item === 'Batteries'), 'and deletes nothing yet');
  await keeper.shot('3-armed');
  await keeper.click('[data-check="trash"]');
  expect(await untilRows('the delete', '_fdata/grocery', (r) => r.length === 3 && !r.some((x) => x.cells.item === 'Batteries')), 'a second click deletes it');
  expect(await keeper.until('it to go', `!${row('Batteries')} && ${heads} === 'dairy|produce'`), 'and it is gone from the page');

  // a stranger at the published address sees the list and changes nothing
  const visitor = await open();
  if (!await visitor.until('the list to draw for a stranger', `document.querySelectorAll('.row').length === 3`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && /You're viewing this list publicly/.test(document.querySelector('.banner')?.textContent ?? '') && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger is told the list is theirs to view');
  expect(await visitor.inFrame(`return !document.querySelector('.add') && [...document.querySelectorAll('.trash')].every((t) => getComputedStyle(t).display === 'none') && !document.querySelector('.clear') && [...document.querySelectorAll('.row input[type="checkbox"]')].every((b) => b.disabled)`), 'and has no box, no delete, no clear and no box to tick');
  expect(await visitor.inFrame(`return ${row('Milk')}.classList.contains('checked') && ${row('2 onions')}.querySelector('.src') && /1 of 3 in the cart/.test(document.querySelector('main').textContent)`), 'the stranger sees the list as it stands');
  await visitor.shot('4-stranger');
  await visitor.inFrame(`${row('Yoghurt')}.querySelector('.label').setAttribute('data-check', 'y'); return true;`);
  await visitor.click('[data-check="y"]');
  await sleep(400);
  expect((await rows('_fdata/grocery')).find((x) => x.cells.item === 'Yoghurt')?.cells.checked === 0, "a stranger's click changes nothing");

  // nobody touches the stranger's page: the push says to read again
  await keeper.fill('.add .f-item', 'Coffee');
  await keeper.fill('.add .f-cat', 'drinks');
  await keeper.press('Enter');
  expect(await untilRows('the new item', '_fdata/grocery', (r) => r.find((x) => x.cells.item === 'Coffee' && x.cells.category === 'drinks')), 'the keeper adds an item');
  expect(await visitor.until('it to reach the stranger', `!!${row('Coffee')}`), "and the stranger's open page is told to read again");

  // clear bought asks for a second click, and takes every checked row
  await mark('Yoghurt', '.label', 'yog');
  await keeper.click('[data-check="yog"]');
  await untilRows('Yoghurt in the cart', '_fdata/grocery', (r) => r.find((x) => x.cells.item === 'Yoghurt' && x.cells.checked === 1));
  expect(await keeper.until('the sweep', `document.querySelector('.foot .clear')?.textContent.trim() === 'clear bought'`), 'clear bought shows once something is in the cart');
  await keeper.click('.foot .clear');
  expect(await keeper.until('the arming', `/click again to clear 2 bought/.test(document.querySelector('.foot .clear.armed')?.textContent ?? '')`), 'one click arms it and says how many');
  await sleep(300);
  expect((await rows('_fdata/grocery')).length === 4, 'and clears nothing yet');
  await keeper.shot('5-clear-armed');
  await keeper.click('.foot .clear');
  const left = await untilRows('the sweep', '_fdata/grocery', (r) => r.length === 2 && r);
  expect(left && left.map((x) => x.cells.item).sort().join('|') === '2 onions|Coffee', 'a second click clears what was bought and nothing else');
  expect(await keeper.until('the page to follow', `document.querySelectorAll('.row').length === 2 && !document.querySelector('.foot')`), 'and the page follows');
  expect(await visitor.until('the stranger to follow', `document.querySelectorAll('.row').length === 2 && !!${row('Coffee')} && !${row('Milk')}`), "and the stranger's page");
  await keeper.shot('6-after');
  await visitor.shot('7-stranger-after');
};
