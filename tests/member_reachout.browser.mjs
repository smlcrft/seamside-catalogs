// Member Reachout in the viewer: the keeper chooses a list, sends and sets what is public;
// a stranger at the published address reads what went to the public roles.
//
// The mail and messages apps are the device's own and are not opened here: the link the
// viewer would hand to the system is kept instead (headless Chrome stops taking clicks
// once an sms: link is handed over), so what is checked is the link, not its delivery.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '')`;
  const said = (re) => `${re}.test(document.body.innerText)`;

  await keeper.evaluate(`window.__handed = []; HTMLAnchorElement.prototype.click = function () { window.__handed.push(this.href); }; return true;`);
  const handed = () => keeper.evaluate(`return window.__handed;`);

  // an editor with no list chosen is asked for one
  if (!await keeper.until('the page to draw', `!!document.querySelector('.page-header h1')`)) return;
  expect(await keeper.until('the ask for a list', `!!document.querySelector('.framelib-choose-opt')`), 'the keeper is asked which members list to use');
  expect(await keeper.inFrame(`return ${said(/There is no members list in this space yet/)}`), 'and told the space has none yet');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.page-header')).display === 'flex' && document.styleSheets.length >= 2`), 'the page has its style');
  await keeper.shot('1-no-list');
  await keeper.click('.framelib-dialog-host .framelib-btn-ghost');
  expect(await keeper.until('the line that says none', `/none yet/.test(${text('.list-line')})`), 'put off, the page says no list is chosen');
  expect(!await keeper.inFrame(`return !!document.querySelector('.new-message')`), 'and offers no message until one is');

  // the roster Member Manager would keep
  await seed('members', 'm1', { name: 'Ann', email: 'ann@example.com', role: 'Parent', phone: '555-0101' });
  await seed('members', 'm2', { name: 'Bob', email: 'bob@example.com', role: 'Parent', phone: '' });
  await seed('members', 'm3', { name: 'Cy', email: 'cy@example.com', role: 'Coach', phone: '555-0103' });
  await untilRows('the roster', 'members', (r) => r.length === 3);

  await keeper.click('.list-line__change');
  expect(await keeper.until('the list to be offered', `[...document.querySelectorAll('.framelib-choose-opt')].some((o) => /members\\.table\\.jsonl · 3 people/.test(o.innerText))`), 'the chooser offers the members list, with how many it holds');
  await keeper.shot('2-choose');
  await keeper.click('.framelib-choose-opt');
  expect(await keeper.until('the list to be in use', `/Members list: members/.test(${text('.list-line')}) && !!document.querySelector('.new-message')`), 'the chosen list is in use and a message can be written');
  expect(await keeper.inFrame(`return ${said(/No messages yet/)}`), 'the log is empty');

  // a stranger before anything is public
  const visitor = await open();
  if (!await visitor.until('the public page to draw', `!!document.querySelector('.page-header h1')`)) return;
  expect(await visitor.until('the empty public log', said(/Nothing has been shared publicly yet/)), 'a stranger is shown no history');
  expect(!await visitor.inFrame(`return !!document.querySelector('.new-message, .list-line, .header-actions button')`), 'and no way to write, choose a list or set anything');
  await visitor.shot('3-stranger-empty');

  // an email to one role
  await keeper.click('.new-message');
  await keeper.until('the message sheet', `document.querySelectorAll('.aud-role').length === 2`);
  expect(await keeper.inFrame(`return [...document.querySelectorAll('.aud-role')].map((l) => l.innerText.replace(/\\s+/g, ' ').trim()).join('|')`) === 'Coach 1|Parent 2', 'the sheet offers the roster\'s roles with their counts');
  expect(await keeper.inFrame(`return document.querySelector('.send--email').disabled`), 'Send waits for an audience and a message');
  await keeper.click('.aud-roles label:nth-of-type(2)');
  await keeper.fill('.sheet-body input[type="text"]', 'Bake sale');
  await keeper.fill('.sheet-body textarea', 'Bring cakes.');
  expect(await keeper.until('the reach', `/reaches ~2/.test(${text('.reach')})`), 'the sheet says how many it reaches');
  expect(!await keeper.inFrame(`return !!document.querySelector('.send--text')`), 'a role with a missing phone number is not offered as text');
  await keeper.shot('4-compose');
  await keeper.click('.send--email');
  expect((await handed()).join() === 'mailto:?bcc=ann%40example.com,bob%40example.com&subject=Bake%20sale&body=Bring%20cakes.', 'one email is handed to the mail app, everyone in bcc');
  const mail = await untilRows('the email', '_fdata/reachout_sent', (r) => r.find((x) => x.cells.message === 'Bring cakes.'));
  expect(mail?.cells.list === 'members' && mail.cells.method === 'email' && mail.cells.subject === 'Bake sale'
    && mail.cells.to_all === false && JSON.stringify(mail.cells.roles) === '["Parent"]'
    && mail.cells.recipient_count === 2 && mail.cells.attempted_count === 2
    && String(mail.cells.sent_by).startsWith('did:') && mail.cells._created_at > 0 && mail.cells._modified_at > 0,
  'the send is a row of the space\'s frame data');
  expect(await keeper.until('the send to list', `/Bake sale — Bring cakes\\./.test(${text('.entry__preview')}) && !document.querySelector('.overlay')`), 'the sheet closes and the log shows the send');
  expect(await keeper.inFrame(`return ${text('.badge')}`) === '1', 'and counts it');
  expect(await visitor.inFrame(`return ${said(/Nothing has been shared publicly yet/)} && !${said(/Bring cakes/)}`), 'a stranger is still shown nothing');

  // the owner makes Parent public and names the board; the stranger's page follows by itself
  await keeper.click('.header-actions button');
  await keeper.until('the settings sheet', `document.querySelectorAll('.role-check').length === 2`);
  await keeper.fill('.sheet--narrow input[type="text"]', 'Club news');
  await keeper.click('.role-checks label:nth-of-type(2)');
  await keeper.shot('5-settings');
  await keeper.click('.sheet-footer.end .send');
  expect(await keeper.until('the title', `${text('.page-header h1')} === 'Club news' && !document.querySelector('.overlay')`), 'the settings are kept and the board is renamed');
  expect(await visitor.until('the public send to arrive by itself', `${text('.page-header h1')} === 'Club news' && /Bring cakes\\./.test(${text('.entry__preview')})`), "the stranger's open page is told, and reads the send made public");
  await visitor.click('.entry__head');
  await visitor.until('the send to open', `!!document.querySelector('.entry__body')`);
  expect(await visitor.inFrame(`return ${text('.entry__count')}`) === '2 emailed', 'opened, it names no sender');
  expect(!await visitor.inFrame(`return !!document.querySelector('.entry__tools')`), 'and offers nothing to change');
  await visitor.shot('6-stranger-public');

  // the roster changes under the open page: the counts follow
  await seed('members', 'm4', { name: 'Dee', email: 'dee@example.com', role: 'Coach', phone: '555-0104' });
  await keeper.click('.new-message');
  expect(await keeper.until('the roster to follow', `/Coach\\s*2/.test(${text('.aud-roles label:nth-of-type(1)')})`, 80), 'a member added elsewhere is counted without a reload');

  // texts to a role where everyone has a number, one tap per person
  await keeper.click('.aud-roles label:nth-of-type(1)');
  await keeper.fill('.sheet-body textarea', 'Practice moved.');
  expect(await keeper.until('Send as text', `!!document.querySelector('.send--text')`), 'a role where everyone has a number can be texted');
  await keeper.click('.send--text');
  expect(await keeper.until('the texting run', `document.querySelectorAll('.runner-row').length === 2`), 'the run lists each person');
  await keeper.click('.runner-row:nth-of-type(1) .runner-send');
  expect((await handed())[1] === 'sms:5550103?body=Practice%20moved.', 'a tap hands one text to the messages app');
  expect(await keeper.until('the tap to mark', `/1\\/2 texted/.test(${text('.sheet-footer .reach')}) && !!document.querySelector('.runner-row.is-done')`), 'a tapped person is marked');
  await keeper.shot('7-texting');
  await keeper.click('.sheet-footer .send--text');
  const sms = await untilRows('the texts', '_fdata/reachout_sent', (r) => r.find((x) => x.cells.message === 'Practice moved.'));
  expect(sms?.cells.method === 'text' && sms.cells.subject === '' && sms.cells.recipient_count === 2 && sms.cells.attempted_count === 1
    && JSON.stringify(sms.cells.roles) === '["Coach"]', 'the run is logged with how many were tapped');
  expect(await keeper.until('both sends', `document.querySelectorAll('.entry').length === 2 && /Coach/.test(${text('.entry__audience')})`), 'the log shows it first');
  await sleep(1000);
  expect(await visitor.inFrame(`return document.querySelectorAll('.entry').length === 1 && !${said(/Practice moved/)}`), 'a send to a role that is not public never reaches the stranger');
  await keeper.shot('8-log');

  // removing the public send takes it from the stranger too
  await keeper.click('.entry:nth-of-type(2) .entry__head');
  await keeper.until('the send to open', `!!document.querySelector('.entry__tools .danger')`);
  expect(await keeper.inFrame(`return /2 emailed/.test(${text('.entry__count')})`), 'opened, the keeper sees how many it went to');
  await keeper.click('.entry__tools .danger');
  await keeper.until('the ask', `!!document.querySelector('.framelib-btn-danger')`);
  await keeper.click('.framelib-btn-danger');
  expect(await untilRows('the send to go', '_fdata/reachout_sent', (r) => r.length === 1 && r[0].cells.message === 'Practice moved.'), 'a removed send is gone from the table, the other kept');
  expect(await keeper.until('the log to follow', `document.querySelectorAll('.entry').length === 1`), 'and from the log');
  expect(await visitor.until('the stranger to follow', said(/Nothing has been shared publicly yet/)), "and from the stranger's page, by itself");
  await visitor.shot('9-stranger-after');
};
