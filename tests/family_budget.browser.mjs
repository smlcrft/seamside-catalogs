// Family Budget in the viewer: the keeper keeping the month, a stranger following along.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const pad2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`;
  const main = `document.querySelector('main').textContent`;
  const cat = (name) => rows('budget_categories').then((r) => r.find((x) => x.cells.name === name));
  // The one element of `selector` whose words match, named so a real click can find it.
  const named = async (b, selector, words, name) => (await b.inFrame(`
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${words}.test(e.textContent));
    if (el) el.setAttribute('data-check', ${JSON.stringify(name)});
    return !!el;`)) ? `[data-check="${name}"]` : `${selector}[data-nothing-matched]`;
  const choose = (b, selector, value, event = 'change') => b.inFrame(`const s = document.querySelector(${JSON.stringify(selector)});
    s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return true;`);
  const modalButton = (b, words, name) => named(b, '.framelib-modal-actions button', words, name);

  // ---- an editor's first look lands the starter categories
  if (!await keeper.until('the starter categories to draw', `document.querySelectorAll('.cat').length === 7`)) return;
  const seeded = await untilRows('the starter categories', 'budget_categories', (r) => r.length === 7 && r);
  expect(seeded && ['pay', 'groceries', 'rent', 'utilities', 'fun', 'transport', 'dining out'].every((n) => seeded.some((x) => x.cells.name === n))
    && seeded.find((x) => x.cells.name === 'pay')?.cells.is_income === 1 && seeded.every((x) => x.cells.monthly_budget === 0 && x.cells._created_at && x.cells._modified_at), 'the keeper opens an empty budget onto seven starter categories, rows of the space');
  expect(await keeper.inFrame(`return !document.querySelector('form') && !document.querySelector('.banner') && !document.querySelector('main').classList.contains('read-only')`), 'the page holds no form and no read-only banner');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('main')).display === 'flex' && getComputedStyle(document.querySelector('.cols')).display === 'grid'`), 'the page has its style');
  expect(await keeper.inFrame(`return document.querySelector('.mode').textContent === 'owner' && /Nothing recorded this month\\./.test(${main})`), 'it says whose it is, and that nothing is recorded yet');
  await keeper.shot('1-seeded');

  // ---- the currency symbol, asked for in the header
  await keeper.click('.drawer');
  if (!await keeper.until('the currency question', `document.querySelector('.framelib-prompt-input')?.value === '$'`)) return;
  await keeper.clear('.framelib-prompt-input');
  await keeper.fill('.framelib-prompt-input', '€');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  expect(await untilRows('the currency', '__fc_settings', (r) => r.find((x) => x.id === 'budget_currency' && x.cells.v === '"€"')), 'the currency is kept as a setting, its value JSON under v');
  expect(await keeper.until('the currency to draw', `document.querySelector('.sum-val').textContent === '€0'`), 'and every amount is drawn with it');

  // ---- categories: one by Enter, one by leaving the box
  await keeper.fill('.grp:nth-child(1) .cat-new input', 'books');
  await keeper.press('Enter');
  const books = await untilRows('the new category', 'budget_categories', (r) => r.find((x) => x.cells.name === 'books'));
  expect(books?.cells.channel === 'c8' && books?.cells.is_income === 0 && books?.cells.monthly_budget === 0 && books?.cells._created_at, 'Enter adds an expense category, coloured next in turn');
  expect(await keeper.until('it to draw', `[...document.querySelectorAll('.grp:nth-child(1) .cat-name')].map((e) => e.textContent).includes('books') && document.querySelector('.grp:nth-child(1) .cat-new input').value === ''`), 'drawn among the expenses, the box cleared');
  await keeper.fill('.grp:nth-child(2) .cat-new input', 'gifts');
  await keeper.inFrame(`document.querySelector('.grp:nth-child(2) .cat-new input').blur(); return true;`);
  expect(await untilRows('the income category', 'budget_categories', (r) => r.find((x) => x.cells.name === 'gifts' && x.cells.is_income === 1)), 'leaving the income box adds an income category');
  expect(await keeper.until('it to draw', `[...document.querySelectorAll('.grp:nth-child(2) .cat-name')].map((e) => e.textContent).join('|') === 'pay|gifts'`), 'drawn among the income');
  await sleep(300);
  expect((await rows('budget_categories')).length === 9, 'nothing is added twice');

  // ---- transactions: one by Enter, one by the button
  const groceries = await cat('groceries'), pay = await cat('pay');
  await choose(keeper, '.tx-add select', groceries.id);
  await keeper.fill('.tx-add .amt', '42.50');
  await keeper.fill('.tx-add .note', 'Market');
  await keeper.press('Enter');
  const market = await untilRows('the purchase', 'budget_transactions', (r) => r.find((x) => x.cells.note === 'Market'));
  expect(market?.cells.amount === 42.5 && market?.cells.category_id === groceries.id && market?.cells.date === today && market?.cells._created_at && market?.cells._modified_at, 'Enter records a purchase, today, a row of the space');
  expect(await keeper.until('it to draw', `/Market/.test(document.querySelector('.txlist').textContent) && document.querySelectorAll('.sum-val')[1].textContent === '€42.50'`), 'and the ledger and the summary draw it');
  expect(await keeper.inFrame(`return document.querySelector('.tx-add .amt').value === '' && document.querySelector('.tx-add .note').value === '' && document.querySelector('.tx-add select').value === ${JSON.stringify(groceries.id)}`), 'the strip is cleared and keeps its category');
  await choose(keeper, '.tx-add select', pay.id);
  await keeper.fill('.tx-add .amt', '1000');
  await keeper.click('.tx-add .go');
  expect(await untilRows('the pay', 'budget_transactions', (r) => r.find((x) => x.cells.category_id === pay.id && x.cells.amount === 1000 && x.cells.note === '')), 'the button records the pay');
  expect(await keeper.until('the balance', `document.querySelector('.sum.balance .sum-val').textContent.trim() === '€957.50' && /\\+€1,000/.test(document.querySelector('.txlist').textContent)`), 'and the balance is money in less money out');
  await keeper.shot('2-month');

  // ---- an envelope, a name and a colour for a category, in its editor
  await keeper.click(await named(keeper, '.cat', /^groceries/, 'groceries'));
  if (!await keeper.until('the category editor', `document.querySelector('.framelib-modal h2')?.textContent === 'Edit category'`)) return;
  await keeper.fill('.ed input', 'food');
  await keeper.press('Enter');
  await untilRows('the rename', 'budget_categories', (r) => r.find((x) => x.id === groceries.id && x.cells.name === 'food'));
  await keeper.click('.pop-swatches button[title="c9"]');
  await untilRows('the colour', 'budget_categories', (r) => r.find((x) => x.id === groceries.id && x.cells.channel === 'c9'));
  await keeper.fill('.ed input.num', '100');
  await keeper.press('Enter');
  const food = await untilRows('the envelope', 'budget_categories', (r) => r.find((x) => x.id === groceries.id && x.cells.monthly_budget === 100));
  expect(food?.cells.name === 'food' && food?.cells.channel === 'c9' && food?.cells._created_at === groceries.cells._created_at, 'a category is renamed, recoloured and given an envelope, over its row');
  await keeper.shot('3-category');
  await keeper.click(await modalButton(keeper, /Done/, 'cat-done'));
  expect(await keeper.until('the envelope to draw', `(() => { const c = document.querySelector('[data-check="groceries"]'); return c && /food/.test(c.textContent) && /\\/ €100/.test(c.textContent) && c.querySelector('.cat-fill')?.style.width === '42.5%'; })()`), 'the envelope is drawn as a bar, filled by what was spent');
  expect(await keeper.inFrame(`return /food/.test(document.querySelector('.txlist').textContent)`), 'and the ledger names the category anew');
  await keeper.click('[data-check="groceries"]');
  await keeper.until('the editor again', `!!document.querySelector('.ed input.num')`);
  await keeper.clear('.ed input.num');
  await keeper.fill('.ed input.num', '40');
  await keeper.press('Enter');
  await untilRows('the smaller envelope', 'budget_categories', (r) => r.find((x) => x.id === groceries.id && x.cells.monthly_budget === 40));
  await keeper.click(await modalButton(keeper, /Done/, 'cat-done2'));
  expect(await keeper.until('the overspend', `!!document.querySelector('[data-check="groceries"] .cat-fill.over')`), 'spending past the envelope is drawn as over');

  // ---- a transaction's editor: amount, note, and a date last month
  await keeper.click(await named(keeper, '.trow', /Market/, 'market'));
  if (!await keeper.until('the transaction editor', `document.querySelector('.framelib-modal h2')?.textContent === 'Edit transaction'`)) return;
  await keeper.clear('.ed input.num');
  await keeper.fill('.ed input.num', '12');
  await keeper.press('Enter');
  await untilRows('the amount', 'budget_transactions', (r) => r.find((x) => x.id === market.id && x.cells.amount === 12));
  await keeper.fill('.ed input[placeholder="Optional"]', 'Corner shop');
  await keeper.press('Enter');
  await untilRows('the note', 'budget_transactions', (r) => r.find((x) => x.id === market.id && x.cells.note === 'Corner shop'));
  await choose(keeper, '.ed input[type="date"]', `${lastMonth}-15`);
  const moved = await untilRows('the date', 'budget_transactions', (r) => r.find((x) => x.id === market.id && x.cells.date === `${lastMonth}-15`));
  expect(moved?.cells.amount === 12 && moved?.cells.note === 'Corner shop' && moved?.cells.category_id === groceries.id && moved?.cells._created_at === market.cells._created_at, 'a transaction is changed field by field, over its row');
  await keeper.click(await modalButton(keeper, /Done/, 'tx-done'));
  expect(await keeper.until('it to leave the month', `!/Corner shop|Market/.test(document.querySelector('.txlist').textContent) && document.querySelectorAll('.sum-val')[1].textContent === '€0'`), 'dated last month, it leaves this one');

  // ---- stepping through months
  await keeper.click('.mnav[title="Previous month"]');
  expect(await keeper.until('last month', `/Corner shop/.test(document.querySelector('.txlist').textContent) && document.querySelectorAll('.sum-val')[1].textContent === '€12' && !!document.querySelector('.mtoday')`), 'the month before shows it, with a way back to today');
  await keeper.shot('4-last-month');
  await keeper.click('.mtoday');
  expect(await keeper.until('this month', `!document.querySelector('.mtoday') && /\\+€1,000/.test(document.querySelector('.txlist').textContent)`), 'today brings the month back');

  // ---- a stranger at the published address follows along, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the month to draw for a stranger', `document.querySelectorAll('.cat').length === 9`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && /viewing this budget publicly/.test(document.querySelector('.banner')?.textContent ?? '') && document.querySelector('.mode').textContent === 'viewer'`), 'a stranger is told the budget is theirs to view');
  expect(await visitor.inFrame(`return !document.querySelector('.cat-new') && !document.querySelector('.tx-add') && !document.querySelector('.drawer')`), 'and has no box, no strip and no settings');
  expect(await visitor.inFrame(`return document.querySelector('.sum.balance .sum-val').textContent.trim() === '€1,000' && /\\+€1,000/.test(document.querySelector('.txlist').textContent)`), 'the stranger sees the month as it stands, in its currency');
  await visitor.click('.cat');
  await visitor.click('.trow');
  await sleep(300);
  expect(await visitor.inFrame(`return !document.querySelector('.framelib-modal')`), "a stranger's click opens no editor");
  await visitor.shot('5-stranger');

  // nobody touches the stranger's page: the push says to read again
  await choose(keeper, '.tx-add select', (await cat('books')).id);
  await keeper.fill('.tx-add .amt', '8');
  await keeper.fill('.tx-add .note', 'atlas');
  await keeper.press('Enter');
  expect(await untilRows('the atlas', 'budget_transactions', (r) => r.find((x) => x.cells.note === 'atlas')), 'the keeper records a purchase');
  expect(await visitor.until('it to reach the stranger', `/atlas/.test(document.querySelector('.txlist').textContent) && document.querySelector('.sum.balance .sum-val').textContent.trim() === '€992'`), "and the stranger's open page is told to read again");

  // ---- delete asks for a second click
  await keeper.click(await named(keeper, '.trow', /atlas/, 'atlas'));
  await keeper.until('the transaction editor', `!!document.querySelector('.ed-del')`);
  await keeper.click('.ed-del');
  expect(await keeper.until('the arming', `document.querySelector('.ed-del.armed')?.textContent.trim() === 'Click again to delete'`), 'one click on delete arms it');
  await sleep(300);
  expect((await rows('budget_transactions')).some((x) => x.cells.note === 'atlas'), 'and deletes nothing yet');
  await keeper.click('.ed-del.armed');
  expect(await untilRows('the delete', 'budget_transactions', (r) => !r.some((x) => x.cells.note === 'atlas')), 'a second click deletes it');
  expect(await visitor.until('it to go for the stranger', `!/atlas/.test(document.querySelector('.txlist').textContent)`), "and it goes from the stranger's page");

  // a category goes with every transaction in it
  await keeper.click('[data-check="groceries"]');
  await keeper.until('the category editor', `!!document.querySelector('.ed-del')`);
  await keeper.click('.ed-del');
  await keeper.click('.ed-del.armed');
  expect(await untilRows('the category to go', 'budget_categories', (r) => !r.some((x) => x.id === groceries.id)), 'a category is deleted on the second click');
  expect(await untilRows('its transactions to go', 'budget_transactions', (r) => !r.some((x) => x.cells.category_id === groceries.id) && r.some((x) => x.cells.category_id === pay.id)), 'and its transactions with it, and nothing else');
  expect(await keeper.until('it to leave the page', `document.querySelectorAll('.cat').length === 8 && ![...document.querySelectorAll('.cat-name')].some((e) => e.textContent === 'food')`), 'it is gone from the page');
  expect(await visitor.until('and from the stranger', `document.querySelectorAll('.cat').length === 8`), "and from the stranger's");
  await keeper.shot('6-after');
  await visitor.shot('7-stranger-after');
};
