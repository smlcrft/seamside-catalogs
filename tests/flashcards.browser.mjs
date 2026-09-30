// Flashcards in the viewer: the keeper makes a deck, writes cards and studies them; a
// stranger at the published address sees the decks, studies nothing, and follows along.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = `(document.getElementById('app')?.textContent ?? '')`;
  const day = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const deck = (name) => `[...document.querySelectorAll('.deck')].find((d) => d.querySelector('.d-name')?.textContent === ${JSON.stringify(name)})`;
  // mark the one element meant, inside one deck, so a selector can say it
  const clickIn = async (b, name, sel) => {
    const ok = await b.inFrame(`
      document.querySelectorAll('[data-pick]').forEach((e) => e.removeAttribute('data-pick'));
      const el = ${deck(name)}?.querySelector(${JSON.stringify(sel)});
      if (el) el.setAttribute('data-pick', '');
      return !!el;`);
    return ok && b.click('[data-pick]');
  };
  const choice = (label) => `[...document.querySelectorAll('.framelib-choose-opt')].find((o) => o.querySelector('.framelib-choose-label').textContent.trim() === ${JSON.stringify(label)})`;
  const choose = async (b, label) => {
    if (!await b.until(`the choice ${label}`, `!!${choice(label)}`)) return;
    await b.inFrame(`${choice(label)}.setAttribute('data-choice', ''); return true;`);
    await b.click('[data-choice]');
  };
  const front = `document.querySelector('.card .face p')?.textContent`;
  const reload = async (b) => {
    await b.send('Page.reload');
    b.child = null;
    for (let i = 0; i < 60 && !b.child; i++) await sleep(250);
  };

  if (!await keeper.until('the decks to draw', `/No decks yet\\. The \\+ up in the corner makes one\\./.test(${text})`)) return;
  expect(await keeper.inFrame(`return document.querySelector('.header .mode').textContent === 'owner' && getComputedStyle(document.querySelector('main')).display === 'flex' && !document.querySelector('form')`), 'the keeper is the owner, the page has its style and holds no form');
  await keeper.shot('1-empty');

  // a deck, from the + and its question
  await keeper.click('.header .iconbtn');
  if (!await keeper.until('the question', `!!document.querySelector('.framelib-prompt-input')`)) return;
  await keeper.fill('.framelib-prompt-input', 'Spanish');
  await keeper.click('.framelib-btn-primary');
  const spanish = await untilRows('the deck', '_fdata/flashcards_decks', (r) => r.find((x) => x.cells.name === 'Spanish'));
  expect(spanish?.cells.sort_order === 0 && spanish?.cells._created_at > 0 && spanish?.cells._modified_at > 0, 'a deck is a row of the space, first in order, stamped');
  if (!await keeper.until('the deck and the card strip', `!!${deck('Spanish')} && !!document.querySelector('.add .f-front')`)) return;

  // two cards, each by Enter
  await keeper.fill('.add .f-front', 'hola');
  await keeper.fill('.add .f-back', 'hello');
  await keeper.press('Enter');
  const hola = await untilRows('the card', '_fdata/flashcards', (r) => r.find((x) => x.cells.front === 'hola'));
  expect(hola?.cells.back === 'hello' && hola?.cells.deck_id === spanish?.id && hola?.cells.added_ms > 0 && hola?.cells._created_at > 0, 'Enter adds a card to the deck, a row of the space');
  expect(await keeper.inFrame(`return document.querySelector('.add .f-front').value === '' && document.querySelector('.add .f-back').value === ''`), 'the strip is emptied for the next card');
  await keeper.fill('.add .f-front', 'gato');
  await keeper.press('Enter');
  await sleep(400);
  expect((await rows('_fdata/flashcards')).length === 1, 'a card with one side is not added');
  await keeper.fill('.add .f-back', 'cat');
  await keeper.press('Enter');
  const gato = await untilRows('the second card', '_fdata/flashcards', (r) => r.find((x) => x.cells.front === 'gato'));
  expect(await keeper.until('the deck to count them', `${deck('Spanish')}?.querySelector('.d-fig .n').textContent === '2' && ${deck('Spanish')}.querySelector('.d-meta').textContent === '2 cards · 2 never seen' && /2 cards ready\\./.test(document.querySelector('.verdict').textContent)`), 'the deck says two are due, never seen');
  await keeper.shot('2-deck');

  // a stranger at the published address, before anyone has studied
  const visitor = await open();
  if (!await visitor.until('the decks for a stranger', `!!${deck('Spanish')}`)) return;
  expect(await visitor.inFrame(`return /Join this space to study these decks — your progress is kept per person\\./.test(${text}) && document.querySelector('.header .mode').textContent === 'viewer'`), 'a stranger is told to join to study');
  expect(await visitor.inFrame(`return !document.querySelector('.add') && !document.querySelector('.btn-primary') && !document.querySelector('.header .iconbtn') && document.querySelector('.d-name').disabled`), 'and has no strip, no study, no new deck and no deck menu');
  await visitor.shot('3-stranger');

  // studying: the front, turned over by space, answered by the button
  await clickIn(keeper, 'Spanish', '.btn-primary');
  if (!await keeper.until('the first card', `${front} === 'hola' && /space to turn it over/.test(${text})`)) return;
  expect(await keeper.inFrame(`return /1 of 2/.test(document.querySelector('.runbar').textContent) && !document.querySelector('.answers')`), 'the session shows one of two and no answers yet');
  await keeper.press(' ', 32);
  if (!await keeper.until('the card to turn', `document.querySelector('.card').classList.contains('flipped') && !!document.querySelector('.answers')`)) return;
  expect(await keeper.inFrame(`return [...document.querySelectorAll('.ans')].map((a) => a.querySelector('.w').textContent + ' ' + a.querySelector('.n').textContent).join(' | ') === 'again tomorrow | hard tomorrow | good tomorrow | easy 4d'`), 'a new card offers tomorrow, tomorrow, tomorrow and four days');
  await keeper.shot('4-turned');
  await keeper.click('.ans.good');
  const first = await untilRows('the review', '_fdata/flashcards_reviews', (r) => r.find((x) => x.cells.card_id === hola?.id));
  expect(first?.cells.reps === 1 && first?.cells.ivl === 1 && first?.cells.ef === 2.5 && first?.cells.due === day(1) && !!first?.cells.user_id && first?.cells.seen_ms > 0 && first?.cells._created_at > 0, 'good on a new card is a review row of the keeper\'s own, due tomorrow');

  // the next by the button and the keys: again sends it round once more
  if (!await keeper.until('the second card', `${front} === 'gato' && /2 of 2/.test(document.querySelector('.runbar').textContent)`)) return;
  await keeper.click('.flipbtn');
  await keeper.until('the card to turn', `!!document.querySelector('.answers')`);
  await keeper.press('1', 49);
  const again = await untilRows('the again', '_fdata/flashcards_reviews', (r) => r.find((x) => x.cells.card_id === gato?.id));
  expect(again?.cells.reps === 0 && again?.cells.ivl === 1 && again?.cells.ef === 1.96, 'the key 1 answers again: reps reset, easiness down');
  if (!await keeper.until('the card to come round again', `${front} === 'gato' && /3 of 3/.test(document.querySelector('.runbar').textContent)`)) return;
  await keeper.press('Enter');
  await keeper.until('the card to turn', `!!document.querySelector('.answers')`);
  await keeper.click('.ans.easy');
  expect(await untilRows('the easy', '_fdata/flashcards_reviews', (r) => r.find((x) => x.cells.card_id === gato?.id && x.cells.reps === 1 && x.cells.ivl === 4 && x.cells.due === day(4))), 'easy graduates it to four days, over the same row');
  expect((await rows('_fdata/flashcards_reviews')).length === 2, 'one row per card for the keeper, never a second');
  expect(await keeper.until('the session to end', `!document.querySelector('.runbar') && /Nothing due — back tomorrow\\./.test(document.querySelector('.verdict')?.textContent ?? '') && ${deck('Spanish')}?.querySelector('.d-fig .n').textContent === '0'`), 'the session ends and says when the next is due');
  expect(await keeper.inFrame(`return ${deck('Spanish')}.querySelector('.btn-primary').disabled && ${deck('Spanish')}.querySelector('.d-meta').textContent === '2 cards'`), 'with nothing to study and nothing unseen');
  await keeper.shot('5-studied');

  // the keeper's schedule is theirs: the stranger's page still has both due
  await reload(visitor);
  expect(await visitor.until('the decks again', `${deck('Spanish')}?.querySelector('.d-fig .n').textContent === '2' && /2 cards ready\\./.test(document.querySelector('.verdict').textContent)`), "a stranger's page never shows the keeper's schedule");

  // rename, from the deck's menu, and the stranger's open page follows by itself
  await clickIn(keeper, 'Spanish', '.d-name');
  await choose(keeper, 'Rename');
  if (!await keeper.until('the rename', `document.querySelector('.framelib-prompt-input')?.value === 'Spanish'`)) return;
  await keeper.fill('.framelib-prompt-input', 'Español');
  await keeper.click('.framelib-btn-primary');
  expect(await untilRows('the new name', '_fdata/flashcards_decks', (r) => r.find((x) => x.id === spanish?.id && x.cells.name === 'Español' && x.cells.sort_order === 0 && x.cells._created_at === spanish?.cells._created_at)), 'a deck is renamed over its row');
  expect(await keeper.until('the new name to draw', `!!${deck('Español')}`), 'and the keeper sees it');
  expect(await visitor.until('the new name for the stranger', `!!${deck('Español')}`), "and the stranger's page is told to read again");

  // a deck and card another device wrote, read on the next visit
  await seed('_fdata/flashcards_decks', 'old', { name: 'French', sort_order: 1, _created_at: 5, _modified_at: 5 });
  await seed('_fdata/flashcards', 'oldc', { deck_id: 'old', front: 'chat', back: 'cat', added_ms: 5, _created_at: 5, _modified_at: 5 });
  await reload(keeper);
  expect(await keeper.until('the old deck', `${deck('French')}?.querySelector('.d-fig .n').textContent === '1' && document.querySelectorAll('.deck')[1] === ${deck('French')} && /1 card ready\\./.test(document.querySelector('.verdict').textContent)`), 'a deck another device wrote is drawn after the first, its card due');
  await keeper.inFrame(`const s = document.querySelector('.add .f-deck'); s.value = 'old'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await keeper.fill('.add .f-front', 'chien');
  await keeper.fill('.add .f-back', 'dog');
  await keeper.press('Enter');
  expect(await untilRows('the card in the old deck', '_fdata/flashcards', (r) => r.find((x) => x.cells.front === 'chien' && x.cells.deck_id === 'old')), 'a card goes into the deck chosen');
  expect(await visitor.until('the card for the stranger', `${deck('French')}?.querySelector('.d-meta').textContent === '2 cards · 2 never seen'`), "and reaches the stranger's open page");
  await keeper.shot('6-two-decks');

  // remove asks first, and takes the cards and the progress with it
  await clickIn(keeper, 'Español', '.d-name');
  await choose(keeper, 'Remove');
  if (!await keeper.until('the confirm', `/Remove "Español" and its 2 cards\\?/.test(document.querySelector('.framelib-prompt-msg')?.textContent ?? '')`)) return;
  await keeper.shot('7-remove');
  await keeper.click('.framelib-btn-ghost');
  await sleep(400);
  expect((await rows('_fdata/flashcards_decks')).length === 2 && await keeper.inFrame(`return !!${deck('Español')}`), 'Cancel removes nothing');
  await clickIn(keeper, 'Español', '.d-name');
  await choose(keeper, 'Remove');
  await keeper.until('the confirm again', `!!document.querySelector('.framelib-btn-primary')`);
  await keeper.click('.framelib-btn-primary');
  expect(await untilRows('the removal', '_fdata/flashcards_decks', (r) => r.length === 1 && r[0].id === 'old'), 'Remove takes the deck out');
  expect(await untilRows('its cards', '_fdata/flashcards', (r) => r.length === 2 && r.every((x) => x.cells.deck_id === 'old')), 'with its cards');
  expect(await untilRows('its progress', '_fdata/flashcards_reviews', (r) => r.length === 0), 'and the progress on them');
  expect(await keeper.until('it to go', `document.querySelectorAll('.deck').length === 1 && !${deck('Español')}`), 'it is gone from the page');
  expect(await visitor.until('it to go for the stranger', `document.querySelectorAll('.deck').length === 1`), "and from the stranger's");
  await keeper.shot('8-after');
  await visitor.shot('9-stranger-after');
};
