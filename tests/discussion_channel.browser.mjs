// Discussion Channel in the viewer: the keeper chatting, a stranger reading along.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  // a setting is the session's own: read it back through the frame
  const viaFrame = async (path, test) => {
    for (let i = 0; i < 60; i++) {
      const v = await keeper.inFrame(`const r = await window.seamside.fetch(${JSON.stringify(path)}); return r.ok ? r.json() : null;`);
      if (v && test(v)) return v;
      await sleep(250);
    }
    return null;
  };

  if (!await keeper.until('the channel to draw', `!!document.querySelector('.dc-root .dc-messages')`)) return;
  expect(await keeper.until('an empty channel', `/No messages yet/.test(document.body.innerText)`), 'the keeper has the channel, empty');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.dc-root')).display === 'grid' && document.styleSheets.length >= 2`), 'the page has its style');
  expect(await keeper.inFrame(`return !document.querySelector('form') && !!document.querySelector('.dc-composer[data-form] textarea')`), 'the composer is there, and no form');
  expect(await keeper.inFrame(`return document.querySelector('.dc-send').disabled`), 'Send waits for something to send');
  await keeper.shot('1-empty');

  const text = '.dc-composer textarea';
  await keeper.fill(text, 'The door sticks.');
  await keeper.shot('2-typed');
  await keeper.click('.dc-send');
  const first = await untilRows('the message', 'discussion_messages', (r) => r.find((x) => x.cells.body === 'The door sticks.'));
  expect(first?.cells.user_id && first?.cells.user_name && first?.cells._created_at && first?.cells._modified_at && typeof first?.cells.created_at === 'number', 'a message sent by the button is a row of the space');
  expect(await keeper.until('the message to draw', `/The door sticks\\./.test(document.querySelector('.dc-msg-body')?.textContent ?? '')`), 'and drawn');
  expect(await keeper.inFrame(`return document.querySelector(${JSON.stringify(text)}).value === ''`), 'and the composer is empty again');

  await keeper.fill(text, 'Sent with Enter.');
  for (const type of ['keyDown', 'keyUp']) {
    await keeper.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, keeper.child);
  }
  expect(await untilRows('the second message', 'discussion_messages', (r) => r.find((x) => x.cells.body === 'Sent with Enter.')), 'Enter sends too');
  expect(await keeper.until('both to draw', `document.querySelectorAll('.dc-msg').length === 2`), 'and both are drawn');

  const visitor = await open();
  if (!await visitor.until('the channel to draw', `document.querySelectorAll('.dc-msg').length === 2`)) return;
  expect(!await visitor.inFrame(`return !!document.querySelector('.dc-composer, .dc-reaction-add, .dc-msg-delete, .dc-icon-btn')`), 'a stranger reads the channel and is offered no way to write');
  expect(await visitor.inFrame(`return document.querySelector('.dc-title-input').disabled`), 'nor to rename it');
  await visitor.shot('3-stranger');

  // nobody touches the visitor's page: the push has it read again
  await keeper.click(`.dc-msg[data-id="${first.id}"] .dc-reaction-add`);
  await keeper.until('the picker', `document.querySelectorAll('.dc-picker button').length === 10`);
  await keeper.shot('4-picker');
  await keeper.click('.dc-picker button[title="heart"]');
  const heart = await untilRows('the reaction', 'discussion_reactions', (r) => r.find((x) => x.cells.icon === 'heart' && x.cells.message_id === first.id));
  expect(heart?.id === `${first.id}:${first.cells.user_id}:heart` && heart?.cells._created_at, 'a reaction is a row keyed by message, person and icon');
  expect(await keeper.until('the reaction to draw', `!!document.querySelector('.dc-msg[data-id="${first.id}"] .dc-reaction.mine .ph-heart')`), 'and drawn as the keeper\'s own');
  expect(await visitor.until('the reaction to arrive by itself', `!!document.querySelector('.dc-msg[data-id="${first.id}"] .dc-reaction .ph-heart')`), "a stranger's open page is told of it");
  expect(await visitor.inFrame(`return document.querySelector('.dc-reaction').disabled`), 'and may not add to it');

  await keeper.fill(text, 'One more.');
  await keeper.click('.dc-send');
  expect(await visitor.until('the new message to arrive by itself', `[...document.querySelectorAll('.dc-msg-body')].some((b) => b.textContent === 'One more.')`), 'and of a new message');

  await keeper.click(`.dc-msg[data-id="${first.id}"] .dc-reaction`);
  expect(await untilRows('the reaction to go', 'discussion_reactions', (r) => r.length === 0), 'the same reaction again takes it back');

  await keeper.click('.dc-topline .dc-icon-btn');
  await keeper.until('the settings', `!!document.querySelector('.dc-settings-fields input[type="text"]')`);
  await keeper.fill('.dc-settings-fields input[type="text"]', 'Town square');
  await keeper.click('.dc-settings-fields input[type="checkbox"]');
  await keeper.shot('5-settings');
  await keeper.click('.dc-save');
  expect(await viaFrame('/api/state', (s) => s.prefs?.title === 'Town square'), 'the title is kept');
  expect(await viaFrame('/api/state', (s) => s.prefs?.public_to_space_viewers === true), 'and the viewers toggle');
  expect(await keeper.until('the title to draw', `document.querySelector('.dc-title-input').value === 'Town square' && !document.querySelector('.dc-settings-fields')`), 'the keeper sees the new title');
  expect(await visitor.until('the title to arrive by itself', `document.querySelector('.dc-title-input').value === 'Town square'`), 'and so does the stranger');
  expect(!await visitor.inFrame(`return !!document.querySelector('.dc-composer')`), 'whom the toggle gives nothing');

  await keeper.fill('.dc-title-input', 'Front porch');
  await keeper.inFrame(`document.querySelector('.dc-title-input').blur(); return true;`);
  expect(await viaFrame('/api/state', (s) => s.prefs?.title === 'Front porch'), 'a title typed over the old one is kept when the field is left');

  await keeper.click(`.dc-msg[data-id="${first.id}"] .dc-msg-delete`);
  expect(await untilRows('the message to go', 'discussion_messages', (r) => r.length === 2 && !r.find((x) => x.id === first.id)), 'a message deleted is gone from the space');
  expect(await keeper.until('it to go from the page', `!document.querySelector('.dc-msg[data-id="${first.id}"]')`), 'and from the page');
  expect(await visitor.until('it to go from the visitor', `document.querySelectorAll('.dc-msg').length === 2 && !document.querySelector('.dc-msg[data-id="${first.id}"]')`), "and from the stranger's");
  await keeper.shot('6-after');
  await visitor.shot('7-stranger-after');
  await sleep(200);
};
