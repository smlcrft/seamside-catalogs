// Meal Planner in the viewer: the keeper planning a week freeform, then from a Recipe Box's
// recipes, sending its ingredients to the grocery list; a stranger following along.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const day = (i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return iso(d); };

  const cell = (i) => `document.querySelectorAll('.dcell:not(.wk-cell)')[${i}]`;
  const card = (title) => `[...document.querySelectorAll('.mcard')].find((c) => c.querySelector('.mc-title')?.textContent === ${JSON.stringify(title)})`;
  const titlesIn = (i) => `[...${cell(i)}.querySelectorAll('.mc-title')].map((t) => t.textContent).join('|')`;
  const button = (label) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  const pcard = (title) => `[...document.querySelectorAll('.pcard')].reverse().find((c) => c.querySelector('.pt')?.textContent === ${JSON.stringify(title)})`;
  const stat = `[...document.querySelectorAll('.wk-cell .stat')].map((s) => s.textContent).join('|')`;
  const modal = `(document.querySelector('.framelib-modal-header h2')?.textContent ?? '')`;
  const mark = (b, el, as) => b.inFrame(`const el = ${el}; if (!el) return false; el.setAttribute('data-check', '${as}'); return true;`);
  const press = async (b, el, as) => { await mark(b, el, as); return b.click(`[data-check="${as}"]`); };
  // An HTML drag, as a person makes one: pressed, carried, let go.
  const at = (b, as) => b.inFrame(`const r = document.querySelector('[data-check="${as}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) };`);
  const drag = async (b, from, to) => {
    const mouse = (type, p, buttons) => b.send('Input.dispatchMouseEvent', { type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', buttons, clickCount: 1 }, b.child);
    const carry = (type, p) => b.send('Input.dispatchDragEvent', { type, x: Math.round(p.x), y: Math.round(p.y), data: { items: [], dragOperationsMask: 16 } }, b.child);
    await b.send('Input.setInterceptDrags', { enabled: true }, b.child);
    await mouse('mouseMoved', from, 0);
    await mouse('mousePressed', from, 1);
    for (let i = 1; i <= 4; i++) await mouse('mouseMoved', { x: from.x + 4 * i, y: from.y + 4 * i }, 1);
    await carry('dragEnter', to);
    for (let i = 0; i < 3; i++) { await carry('dragOver', to); await sleep(50); }
    await carry('drop', to);
    await mouse('mouseReleased', to, 0);
    await b.send('Input.setInterceptDrags', { enabled: false }, b.child);
    await sleep(500);
  };

  // ----- an empty week, no recipe box in the space
  if (!await keeper.until('the week to draw', `document.querySelectorAll('.dcell:not(.wk-cell)').length === 7`)) return;
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && !document.querySelector('.banner') && !document.querySelector('form') && ${stat} === '0 meals' && !document.querySelector('.wk-cell .send')`), 'the keeper is the owner of an empty week, with nothing to send');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.wgrid')).display === 'grid' && getComputedStyle(document.querySelector('main')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-empty');

  // ----- a freeform meal, typed and added on Enter
  await press(keeper, `${cell(0)}.querySelector('.addzone')`, 'add0');
  expect(await keeper.until('the add sheet', `${modal}.startsWith('Add a meal')`), 'the + opens the add sheet');
  expect(await keeper.inFrame(`return !document.querySelector('.psearch, .pgrid') && document.querySelector('.mdraft input').placeholder === 'Or just type a meal…'`), 'with no recipes it is a freeform meal');
  await keeper.fill('.mdraft input', 'Tacos');
  await keeper.press('Enter');
  const tacos = await untilRows('the meal', 'meal_plan', (r) => r.find((x) => x.cells.title === 'Tacos'));
  expect(tacos?.cells.day_date === day(0) && tacos?.cells.slot === 'dinner' && tacos?.cells.recipe_id === '' && tacos?.cells.servings === 0 && tacos?.cells.notes === '' && tacos?.cells._created_at && tacos?.cells._modified_at, "Enter adds it on that day, a row of the space in the contract's shape");
  expect(await keeper.until('it to draw', `${titlesIn(0)} === 'Tacos' && !document.querySelector('.framelib-modal')`), 'and the sheet closes on the card');

  // ----- another, in a slot chosen by its chip, added by the button
  await press(keeper, `${cell(1)}.querySelector('.addzone')`, 'add1');
  await keeper.until('the add sheet', `!!document.querySelector('.slot-chips')`);
  await press(keeper, button('lunch'), 'lunch');
  await keeper.fill('.mdraft input', 'Soup');
  await press(keeper, button('Add meal'), 'addmeal');
  const soup = await untilRows('the lunch', 'meal_plan', (r) => r.find((x) => x.cells.title === 'Soup'));
  expect(soup?.cells.slot === 'lunch' && soup?.cells.day_date === day(1), 'a chip sets the slot and the button adds it');
  expect(await keeper.until('the stat', `${stat} === '2 meals' && ${card('Soup')}?.querySelector('.mc-slot').textContent === 'lunch'`), 'the week counts two meals');

  // ----- a Recipe Box's recipes arrive by themselves, and the sheet offers them
  const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await seed('recipes', 'r1', { title: 'Pancakes', ingredients_lines: '2 cups flour\n2 eggs\nmilk', steps_lines: 'Mix\nFry', servings: 4, tags: 'breakfast', notes: '', created_ms: 1, photo, _created_at: 1, _modified_at: 1 });
  await seed('recipes', 'r2', { title: 'Chili', ingredients_lines: 'beans\nonion', steps_lines: '', servings: 0, tags: 'dinner', notes: '', created_ms: 2, photo: '', _created_at: 2, _modified_at: 2 });
  await sleep(800);
  await press(keeper, `${cell(2)}.querySelector('.addzone')`, 'add2');
  expect(await keeper.until('the recipe book', `document.querySelectorAll('.pgrid .pcard').length === 2`), "recipes another frame wrote reach the keeper's page, in the add sheet");
  expect(await keeper.inFrame(`return [...document.querySelectorAll('.pcard .pt')].map((t) => t.textContent).join('|') === 'Chili|Pancakes' && !!${pcard('Pancakes')}.querySelector('img.pimg') && /serves 4/.test(${pcard('Pancakes')}.textContent)`), 'by title, with the picture and servings each has');
  await keeper.shot('2-book');
  await keeper.fill('.psearch input', 'pan');
  expect(await keeper.until('the search', `document.querySelectorAll('.pgrid .pcard').length === 1`), 'the search narrows the book');
  await keeper.press('Enter');
  expect(await keeper.until('the pick', `document.querySelector('.pcard.sel .pt')?.textContent === 'Pancakes' && document.querySelector('.mdraft input').value === 'Pancakes'`), 'Enter on the one left picks it, and takes its title');
  await press(keeper, button('breakfast'), 'breakfast');
  await press(keeper, button('Add meal'), 'addmeal2');
  const cakes = await untilRows('the recipe meal', 'meal_plan', (r) => r.find((x) => x.cells.recipe_id === 'r1'));
  expect(cakes?.cells.title === 'Pancakes' && cakes?.cells.slot === 'breakfast' && cakes?.cells.day_date === day(2), 'a meal on a recipe points at it, its title snapshotted');
  expect(await keeper.until('the recipe card', `!!${card('Pancakes')}?.querySelector('img.photo') && !!${card('Pancakes')}?.querySelector('.mc-recipe') && ${stat} === '3 meals · 1 recipe' && !!document.querySelector('.wk-cell .send')`), 'the card wears the recipe, and the week can be sent');

  // ----- the week's ingredients go to the grocery list, once
  await seed('grocery', 'g1', { item: '2 eggs', quantity: '', category: '', checked: 0, source: 'r1', added_ms: 1, _created_at: 1, _modified_at: 1 });
  await keeper.click('.wk-cell .send');
  const sent = await untilRows('the ingredients', 'grocery', (r) => r.length === 3 && r);
  const flour = sent?.find((x) => x.cells.item === '2 cups flour');
  expect(flour?.cells.source === 'r1' && flour?.cells.checked === 0 && flour?.cells.quantity === '' && flour?.cells.category === '' && flour?.cells.added_ms > 0 && flour?.cells._created_at && sent?.some((x) => x.cells.item === 'milk'), "send puts the recipe's lines on the list in the grocery contract's shape, skipping what is there");
  expect(sent?.find((x) => x.id === 'g1')?.cells._modified_at === 1, 'and leaves the row already there alone');
  expect(await keeper.until('the note', `${stat}.includes('sent 2 items to the grocery list')`), 'the page says how many went');
  await keeper.shot('3-sent');
  await keeper.click('.wk-cell .send');
  expect(await keeper.until('the second note', `${stat}.includes('sent 0 items to the grocery list')`), 'sending again sends nothing');
  expect((await rows('grocery')).length === 3, 'and the list holds nothing twice');

  // ----- a meal edited: servings, notes, a recipe picked for it
  await press(keeper, card('Tacos'), 'tacos');
  expect(await keeper.until('the editor', `${modal} === 'Edit meal'`), 'a click on a card opens it to edit');
  await keeper.fill('.ed input[type="number"]', '3');
  await keeper.press('Enter');
  expect(await untilRows('the servings', 'meal_plan', (r) => r.find((x) => x.id === tacos?.id && x.cells.servings === 3 && x.cells.title === 'Tacos' && x.cells._created_at === tacos?.cells._created_at)), 'servings are kept on Enter, over the row');
  await keeper.fill('.ed textarea', 'extra salsa');
  await keeper.inFrame(`document.querySelector('.ed textarea').blur(); return true;`);
  expect(await untilRows('the notes', 'meal_plan', (r) => r.find((x) => x.id === tacos?.id && x.cells.notes === 'extra salsa' && x.cells.servings === 3)), 'notes are kept on leaving the box');
  await keeper.click('.ed .pickbtn');
  expect(await keeper.until('the picker', `[...document.querySelectorAll('.framelib-modal-header h2')].some((h) => h.textContent === 'Pick a recipe')`), 'the recipe row opens the book');
  await press(keeper, pcard('Chili'), 'chili');
  const chili = await untilRows('the recipe', 'meal_plan', (r) => r.find((x) => x.id === tacos?.id && x.cells.recipe_id === 'r2'));
  expect(chili?.cells.title === 'Chili' && chili?.cells.notes === 'extra salsa', 'a recipe picked for a meal takes its title and keeps the rest');
  expect(await keeper.until('the editor to follow', `document.querySelector('.ed .pickbtn .pb-name')?.textContent === 'Chili' && !!${card('Chili')}`), 'and the sheet and card say so');
  await keeper.shot('4-edit');
  await press(keeper, button('Done'), 'done');
  await keeper.until('the sheet to close', `!document.querySelector('.framelib-modal')`);

  // ----- a meal dragged to another day
  await mark(keeper, card('Soup'), 'soup');
  await mark(keeper, cell(4), 'friday');
  await drag(keeper, await at(keeper, 'soup'), await at(keeper, 'friday'));
  expect(await untilRows('the move', 'meal_plan', (r) => r.find((x) => x.id === soup?.id && x.cells.day_date === day(4) && x.cells.slot === 'lunch')), 'a card dragged to another day moves the meal there');
  expect(await keeper.until('it to draw there', `${titlesIn(4)} === 'Soup' && ${titlesIn(1)} === ''`), 'and it is drawn there');

  // ----- a stranger at the published address follows the week and changes nothing
  const visitor = await open();
  if (!await visitor.until('the week for a stranger', `document.querySelectorAll('.mcard').length === 3`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && /You're viewing this meal plan publicly/.test(document.querySelector('.banner')?.textContent ?? '') && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger is told the plan is theirs to view');
  expect(await visitor.inFrame(`return !document.querySelector('.addzone, .wk-cell .send')`), 'with nothing to add or send');
  expect(await visitor.inFrame(`return !!${card('Pancakes')}.querySelector('img.photo') && ${titlesIn(4)} === 'Soup'`), 'and the week as it stands, pictures included');
  await press(visitor, card('Pancakes'), 'cakes');
  expect(await visitor.until('the meal', `${modal} === 'Meal' && !document.querySelector('.ed input, .ed textarea, .ed-del') && /Pancakes/.test(document.querySelector('.ed').textContent) && /breakfast/.test(document.querySelector('.ed').textContent)`), 'a click shows the meal, read-only');
  await visitor.shot('5-stranger');
  await visitor.click('.framelib-modal-close');
  await mark(visitor, card('Pancakes'), 'vcakes');
  await mark(visitor, cell(6), 'sunday');
  await drag(visitor, await at(visitor, 'vcakes'), await at(visitor, 'sunday'));
  expect((await rows('meal_plan')).find((x) => x.id === cakes?.id)?.cells.day_date === day(2), "a stranger's drag moves nothing");

  // nobody touches the stranger's page: the push says to read again
  await press(keeper, `${cell(5)}.querySelector('.addzone')`, 'add5');
  await keeper.until('the add sheet', `!!document.querySelector('.mdraft input')`);
  await keeper.fill('.mdraft input', 'Pizza night');
  await keeper.press('Enter');
  expect(await untilRows('the new meal', 'meal_plan', (r) => r.find((x) => x.cells.title === 'Pizza night' && x.cells.day_date === day(5))), 'the keeper adds a meal');
  expect(await visitor.until('it to reach the stranger', `${titlesIn(5)} === 'Pizza night'`), "and the stranger's open page is told to read again");

  // ----- a meal deleted with a second click
  await press(keeper, card('Soup'), 'soup2');
  await keeper.until('the editor', `${modal} === 'Edit meal'`);
  await press(keeper, button('Delete meal'), 'del');
  expect(await keeper.until('the arming', `!!document.querySelector('.ed-del.armed') && document.querySelector('.ed-del').textContent.trim() === 'Click again to delete'`), 'one click on delete arms it');
  await sleep(300);
  expect((await rows('meal_plan')).some((x) => x.id === soup?.id), 'and deletes nothing yet');
  await keeper.click('.ed-del.armed');
  expect(await untilRows('the delete', 'meal_plan', (r) => !r.some((x) => x.id === soup?.id) && r), 'a second click deletes it');
  expect(await keeper.until('it to go', `${titlesIn(4)} === '' && !document.querySelector('.framelib-modal')`), 'and it is gone from the page');
  expect(await visitor.until('it to go for the stranger', `${titlesIn(4)} === ''`), "and from the stranger's");

  // ----- weeks
  await keeper.click('.iconbtn[title="Next week"]');
  expect(await keeper.until('next week', `${stat} === '0 meals' && !!${button('this week')} && !document.querySelector('.mcard')`), 'the next week is its own, empty, with a way back');
  await keeper.shot('6-next-week');
  await press(keeper, button('this week'), 'back');
  expect(await keeper.until('this week', `document.querySelectorAll('.mcard').length === 3 && !${button('this week')}`), 'and this week comes back');
  await keeper.shot('7-after');
  await visitor.shot('8-stranger-after');
};
