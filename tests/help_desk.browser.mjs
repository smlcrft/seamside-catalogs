// Help Desk in the viewer: the keeper at the inbox, a stranger at the form.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  if (!await keeper.until('the inbox to draw', `!!document.querySelector('.hd-admin')`)) return;
  expect(await keeper.until('an empty inbox', `/No messages yet/.test(document.body.innerText)`), 'the keeper has the inbox, empty');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.hd-admin')).display !== 'inline' && document.styleSheets.length >= 2`), 'the page has its style');
  await keeper.shot('1-inbox-empty');

  const visitor = await open();
  if (!await visitor.until('the form to draw', `!!document.querySelector('.hd-anon #hd-email')`)) return;
  expect(!await visitor.inFrame(`return !!document.querySelector('.hd-admin')`), 'a stranger has the form and no inbox');
  expect(await visitor.inFrame(`return !!document.querySelector('#hd-f-default_message')`), 'the form has the Message field');
  const send = `.hd-anon [data-form] button`;
  await visitor.click(send);
  await sleep(500);
  expect((await rows('_fdata/help_desk_submissions')).length === 0 && !await visitor.inFrame(`return /Message sent/.test(document.body.innerText)`), 'Send with no email sends nothing');
  await visitor.fill('#hd-email', 'not-an-email');
  await visitor.click(send);
  await sleep(500);
  expect((await rows('_fdata/help_desk_submissions')).length === 0, 'an address that is not one is not sent');
  await visitor.fill('#hd-email', 'pat@example.com');
  await visitor.fill('#hd-f-default_message', 'The door sticks.');
  await visitor.shot('2-form');
  await visitor.click(send);
  expect(await visitor.until('the page to say it was sent', `/Message sent/.test(document.body.innerText)`), 'the visitor is told it was sent');
  const sub = await untilRows('the message', '_fdata/help_desk_submissions', (r) => r.find((x) => x.cells.email === 'pat@example.com'));
  expect(sub?.cells.status === 'new' && sub?.cells.fields_json === '{"default_message":"The door sticks."}', 'the message is a row of the space');

  // nobody touches the keeper's page: the push brings the message to it
  expect(await keeper.until('the message to arrive by itself', `/pat@example.com/.test(document.querySelector('.hd-sub')?.innerText ?? '')`), "the keeper's open page is told of the message");
  expect(await keeper.until('the toast', `/New message from pat@example.com/.test(document.body.innerText)`, 8), 'and says who it is from');
  await keeper.shot('3-inbox');
  await keeper.click('.hd-sub-head');
  await keeper.until('the message to open', `!!document.querySelector('.hd-sub-detail select')`);
  expect(await keeper.inFrame(`return /The door sticks\./.test(document.querySelector('.hd-sub-detail').innerText)`), 'the opened message shows what was written');
  await keeper.inFrame(`const s = document.querySelector('.hd-sub-detail select'); s.value = 'in_progress'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  expect(await untilRows('the status', '_fdata/help_desk_submissions', (r) => r.find((x) => x.cells.status === 'in_progress' && x.cells.email === 'pat@example.com')), 'a status chosen is kept, over the row as it was');
  expect(await keeper.until('the pill to follow', `/in progress/.test(document.querySelector('.hd-sub-head .hd-status-pill').textContent)`), 'and the inbox shows it');
  await keeper.fill('.hd-note-form textarea', 'Called back.');
  await keeper.click('.hd-note-form button');
  const note = await untilRows('the note', '_fdata/help_desk_notes', (r) => r.find((x) => x.cells.body === 'Called back.'));
  expect(note?.cells.submission_id === sub?.id, 'a note is kept against its message');
  expect(await keeper.until('the note to draw', `/Called back\./.test(document.querySelector('.hd-notes')?.innerText ?? '')`), 'and drawn from the answer');
  await keeper.shot('4-note');

  await keeper.click('.hd-tab:nth-child(2)');
  await keeper.until('the fields page', `!!document.querySelector('.hd-add-form')`);
  await keeper.click('.hd-add-form button');
  await sleep(400);
  expect((await rows('_fdata/help_desk_fields')).length === 1, 'a field with no label is not added');
  await keeper.fill('.hd-add-form input[type="text"]', 'Phone');
  await keeper.click('.hd-add-form button');
  expect(await untilRows('the field', '_fdata/help_desk_fields', (r) => r.find((x) => x.cells.label === 'Phone' && x.cells.sort_order === 1)), 'a field is added after the last');
  expect(await keeper.until('the field to list', `[...document.querySelectorAll('.hd-field-row .label')].some((l) => l.textContent === 'Phone')`), 'and listed');
  await keeper.fill('.hd-title-edit input', 'Front desk');
  await keeper.inFrame(`document.querySelector('.hd-title-edit input').blur(); return true;`);
  expect(await untilRows('the title', '_settings', (r) => r.find((x) => x.id === 'help_desk_title' && x.cells.v === '"Front desk"')), 'the title is kept as a setting of the frame\'s own');
  await keeper.shot('5-fields');

  await visitor.send('Page.reload');
  visitor.child = null;
  for (let i = 0; i < 60 && !visitor.child; i++) await sleep(250);
  expect(await visitor.until('the form again', `document.querySelector('.hd-public-title')?.textContent === 'Front desk' && [...document.querySelectorAll('.hd-field label')].some((l) => /Phone/.test(l.textContent))`), 'a visitor who comes back has the new title and the new field');
  await visitor.shot('6-form-again');
};
