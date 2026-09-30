// Roundtable in the viewer: the keeper at the table, a stranger following along.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const positive = `.rt-col[data-kind="positive"]`, negative = `.rt-col[data-kind="negative"]`;

  // a setting is the session's own: read it back through the frame
  const viaFrame = async (path, test) => {
    for (let i = 0; i < 60; i++) {
      const v = await keeper.inFrame(`const r = await window.seamside.fetch(${JSON.stringify(path)}); return r.ok ? r.json() : null;`);
      if (v && test(v)) return v;
      await sleep(250);
    }
    return null;
  };

  if (!await keeper.until('the table to draw', `!!document.querySelector('.rt-root .rt-main')`)) return;
  expect(await keeper.inFrame(`return document.querySelectorAll('.rt-item-composer').length === 2 && !!document.querySelector('.rt-composer textarea')`), 'the keeper has both lists and the discussion, each with its composer');
  expect(await keeper.inFrame(`return !document.querySelector('form')`), 'the page holds no form');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.rt-main')).display === 'grid' && getComputedStyle(document.querySelector('.rt-item-composer')).display !== 'inline'`), 'the page has its style');
  expect(await keeper.inFrame(`return !!document.querySelector('.rt-topline .rt-icon-btn') && !document.querySelector('.rt-title-input').disabled`), 'the owner has the settings and the title');
  await keeper.shot('1-empty');

  // an item by the button, one by Enter; an empty composer adds nothing
  await keeper.click(`${positive} .rt-item-composer button`);
  await sleep(400);
  expect((await rows('roundtable_items')).length === 0, 'Add with nothing written adds nothing');
  await keeper.fill(`${positive} .rt-item-composer input`, 'A bench by the door');
  await keeper.click(`${positive} .rt-item-composer button`);
  const bench = await untilRows('the item', 'roundtable_items', (r) => r.find((x) => x.cells.body === 'A bench by the door'));
  expect(bench?.cells.kind === 'positive' && bench?.cells.user_id && bench?.cells._created_at && bench?.cells._modified_at, 'an item added by the button is a row of the space');
  const own = await untilRows('its vote', 'roundtable_votes', (r) => r.find((x) => x.cells.item_id === bench?.id));
  expect(own?.id === `${bench?.id}:${bench?.cells.user_id}`, "with its author's vote, keyed by the two");
  expect(await keeper.until('the item to draw', `document.querySelector('${positive} .rt-item .rt-item-text')?.textContent === 'A bench by the door' && document.querySelector('${positive} .rt-vote.mine .count')?.textContent === '1'`), 'and drawn with one vote, the keeper\'s own');
  expect(await keeper.inFrame(`return document.querySelector('${positive} .rt-item-composer input').value === ''`), 'the composer is cleared');

  await keeper.fill(`${negative} .rt-item-composer input`, 'The door sticks');
  await keeper.press('Enter');
  const door = await untilRows('the second item', 'roundtable_items', (r) => r.find((x) => x.cells.body === 'The door sticks'));
  expect(door?.cells.kind === 'negative', 'Enter in the field adds an item to its own list');
  expect(await keeper.until('it to draw', `document.querySelector('${negative} .rt-item .rt-item-text')?.textContent === 'The door sticks'`), 'and it is drawn there');

  // a message by Enter, one by the button
  await keeper.fill('.rt-composer textarea', 'Hello all.');
  await keeper.press('Enter');
  expect(await untilRows('the message', 'roundtable_messages', (r) => r.find((x) => x.cells.body === 'Hello all.' && x.cells._created_at)), 'Enter sends a message, a row of the space');
  await keeper.fill('.rt-composer textarea', 'And again.');
  await keeper.click('.rt-composer .rt-send');
  expect(await keeper.inFrame(`return document.querySelector('.rt-composer textarea').value === ''`), 'and leaves the field empty');
  expect(await untilRows('the second message', 'roundtable_messages', (r) => r.length === 2 && r.find((x) => x.cells.body === 'And again.')), 'the button sends one too');
  expect(await keeper.until('both to draw', `[...document.querySelectorAll('.rt-msg-body')].map((m) => m.textContent).join('|') === 'Hello all.|And again.'`), 'and both are drawn, in order');
  await keeper.shot('2-filled');

  const visitor = await open();
  if (!await visitor.until('the table to draw for a stranger', `!!document.querySelector('.rt-root .rt-main')`)) return;
  expect(await visitor.until('what is there', `document.querySelector('${positive} .rt-item-text')?.textContent === 'A bench by the door' && document.querySelectorAll('.rt-msg-body').length === 2`), 'a stranger is shown the lists and the discussion');
  expect(await visitor.inFrame(`return !document.querySelector('.rt-item-composer') && !document.querySelector('.rt-composer') && !document.querySelector('.rt-item-delete') && !document.querySelector('.rt-msg-delete') && !document.querySelector('.rt-topline .rt-icon-btn')`), 'and no composer, no delete and no settings');
  expect(await visitor.inFrame(`return document.querySelector('.rt-vote').disabled && document.querySelector('.rt-title-input').disabled && !document.querySelector('.rt-vote.mine')`), 'a vote is a count to them, and the title is not theirs to change');
  await visitor.shot('3-stranger');

  // nobody touches the stranger's page: a push says to read again
  await keeper.click(`${positive} .rt-vote`);
  expect(await untilRows('the vote to go', 'roundtable_votes', (r) => !r.some((x) => x.cells.item_id === bench?.id)), 'a vote clicked again is taken back');
  expect(await keeper.until('the count to follow', `document.querySelector('${positive} .rt-vote .count')?.textContent === '0' && !document.querySelector('${positive} .rt-vote.mine')`), 'and the keeper sees none');
  expect(await visitor.until('the count to reach the stranger', `document.querySelector('${positive} .rt-vote .count')?.textContent === '0'`), "and the stranger's open page is told to read again");
  await keeper.click(`${positive} .rt-vote`);
  expect(await untilRows('the vote to come back', 'roundtable_votes', (r) => r.find((x) => x.id === own?.id)), 'and given again, the same row');

  // settings: the sheet, then the title in place
  await keeper.click('.rt-topline .rt-icon-btn');
  await keeper.until('the settings to open', `!!document.querySelector('.rt-settings-fields')`);
  await keeper.shot('4-settings');
  await keeper.fill('.rt-settings-fields label:nth-child(2) input', 'Wishes');
  await keeper.click('.rt-settings-fields .rt-check-row input');
  await keeper.click('.rt-save');
  expect(await viaFrame('/api/state', (s) => s.prefs?.positive_label === 'Wishes'), 'a label is kept');
  expect(await viaFrame('/api/state', (s) => s.prefs?.public_to_space_viewers === true), 'and the viewers toggle');
  expect(await keeper.until('the sheet to close and the page to follow', `!document.querySelector('.rt-settings-fields') && /Wishes/.test(document.querySelector('${positive} .rt-col-header .label').textContent) && !!document.querySelector('.rt-badge-open')`), 'the page shows the label and says viewers contribute');
  expect(await visitor.until('the label to reach the stranger', `/Wishes/.test(document.querySelector('${positive} .rt-col-header .label').textContent)`), 'the stranger has the new label');
  expect(await visitor.inFrame(`return !document.querySelector('.rt-badge-open') && !document.querySelector('.rt-composer')`), 'and still no badge and no composer');
  await keeper.fill('.rt-title-input', 'Town hall');
  await keeper.inFrame(`document.querySelector('.rt-title-input').blur(); return true;`);
  expect(await viaFrame('/api/state', (s) => s.prefs?.title === 'Town hall'), 'the title is kept on leaving the field');
  expect(await visitor.until('the title to reach the stranger', `document.querySelector('.rt-title-input').value === 'Town hall'`), 'and the stranger has it');

  // deleting: an item asks first, a message does not
  await keeper.click(`${negative} .rt-item-delete`);
  await keeper.until('the question', `!!document.querySelector('.framelib-dialog-host .framelib-btn-danger')`);
  await keeper.shot('5-confirm');
  await keeper.click('.framelib-dialog-host .framelib-btn-ghost');
  await sleep(400);
  expect((await rows('roundtable_items')).length === 2, 'Cancel leaves the item');
  await keeper.click(`${negative} .rt-item-delete`);
  await keeper.until('the question again', `!!document.querySelector('.framelib-dialog-host .framelib-btn-danger')`);
  await keeper.click('.framelib-dialog-host .framelib-btn-danger');
  expect(await untilRows('the item to go', 'roundtable_items', (r) => r.length === 1 && r[0].id === bench?.id), 'Delete removes it');
  expect(await untilRows('its vote to go', 'roundtable_votes', (r) => r.length === 1 && r[0].cells.item_id === bench?.id), 'with its vote');
  await keeper.click('.rt-msg-delete');
  expect(await untilRows('the message to go', 'roundtable_messages', (r) => r.length === 1 && r[0].cells.body === 'And again.'), 'a message is removed by its author');
  expect(await visitor.until('both to leave the stranger\'s page', `!document.querySelector('${negative} .rt-item') && document.querySelectorAll('.rt-msg-body').length === 1`), 'and the stranger sees both gone');
  await keeper.shot('6-after');
  await visitor.shot('7-stranger-after');
};
