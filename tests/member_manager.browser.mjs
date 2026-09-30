// Member Manager in the viewer: the keeper choosing a list and keeping the roster, a
// stranger at the published address shown names and roles.

const LIST = 'club.members';

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  // unbound, an editor is asked which list to use
  if (!await keeper.until('the chooser', `/There is no members list in this space yet/.test(document.body.innerText) && !!document.querySelector('.framelib-choose-opt')`)) return;
  expect(await keeper.inFrame(`return document.styleSheets.length >= 2 && getComputedStyle(document.querySelector('.page-header')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-choose');
  await keeper.click('.framelib-choose-opt');
  await keeper.until('the name to be asked', `!!document.querySelector('.framelib-prompt-input')`);
  await keeper.fill('.framelib-prompt-input', 'Club');
  await keeper.click('.framelib-btn-primary');
  expect(await keeper.until('the list to be named', `document.querySelector('.list-line strong')?.textContent === 'club'`), 'a new list is chosen and said');
  expect(await keeper.until('the row to add with', `!!document.querySelector('.compose') && /No members yet — add the first one above/.test(document.body.innerText)`), 'an editor has the row to add with, and an empty roster');
  await keeper.shot('2-empty');

  const add = async (name, email, phone, role) => {
    await keeper.fill('.compose input[type="text"]', name);
    await keeper.fill('.compose input[type="email"]', email);
    if (phone) await keeper.fill('.compose input[type="tel"]', phone);
    if (role) await keeper.inFrame(`const s = document.querySelector('.compose select'); s.value = ${JSON.stringify(role)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await keeper.click('.compose button');
  };
  const named = (name) => `[...document.querySelectorAll('.member')].find((m) => m.querySelector('.member__name').textContent === ${JSON.stringify(name)})`;

  await keeper.click('.compose button');
  await sleep(500);
  expect((await rows(LIST)).length === 0, 'Add with nothing filled in adds nobody');

  await add('Pat Lee', 'pat@example.com', '555-0100', 'Member');
  const pat = await untilRows('the member', LIST, (r) => r.find((x) => x.cells.email === 'pat@example.com'));
  expect(pat?.cells.name === 'Pat Lee' && pat?.cells.phone === '555-0100' && pat?.cells.role === 'Member' && pat?.cells._created_at > 0 && pat?.cells._modified_at > 0, 'a member added is a row of the chosen list, stamped');
  expect(await keeper.until('the member to draw', `/pat@example.com/.test(${named('Pat Lee')}?.innerText ?? '') && document.querySelector('.badge').textContent === '1'`), 'and is drawn, with the count');
  expect(await keeper.inFrame(`return document.querySelector('.compose input[type="text"]').value === ''`), 'the row to add with is cleared');
  await add('Ann Ames', 'ann@example.com', '', 'Admin');
  await untilRows('the second member', LIST, (r) => r.find((x) => x.cells.email === 'ann@example.com'));
  expect(await keeper.until('the roster in order', `[...document.querySelectorAll('.member__name')].map((n) => n.textContent).join() === 'Ann Ames,Pat Lee'`), 'the roster is by role, then by name');
  await keeper.shot('3-roster');

  // a stranger at the published address
  const visitor = await open();
  if (!await visitor.until('the public roster', `document.querySelectorAll('.public-row').length === 2`)) return;
  expect(await visitor.inFrame(`return [...document.querySelectorAll('.public-row')].map((r) => r.querySelector('.public-name').textContent + ' ' + r.querySelector('.public-role').textContent).join('|') === 'Ann Ames Admin|Pat Lee Member'`), 'a stranger is shown names and roles');
  expect(await visitor.inFrame(`return !/example\\.com|555-0100/.test(document.getElementById('root').innerHTML)`), 'and no email or phone, anywhere in what was drawn');
  expect(await visitor.inFrame(`return !document.querySelector('.compose') && !document.querySelector('.header-actions button') && !document.querySelector('.list-line__change') && !document.querySelector('.member__actions') && !document.querySelector('.framelib-choose-opt')`), 'with nothing to add, edit, choose or set');
  await visitor.shot('4-public');

  // the keeper changes a role from the row
  await keeper.inFrame(`const s = ${named('Pat Lee')}.querySelector('.role-select'); s.value = 'Guest'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  expect(await untilRows('the role', LIST, (r) => r.find((x) => x.id === pat.id && x.cells.role === 'Guest' && x.cells.email === 'pat@example.com' && x.cells.phone === '555-0100' && x.cells._created_at === pat.cells._created_at)), 'a role chosen is kept, over the row as it was');
  expect(await visitor.until('the role to arrive by itself', `[...document.querySelectorAll('.public-row')].some((r) => /Pat Lee/.test(r.textContent) && /Guest/.test(r.textContent))`), "the stranger's open page is told to read again");

  // edit by the dialog
  await keeper.inFrame(`${named('Pat Lee')}.querySelector('.edit').setAttribute('data-check', 'edit'); return true;`);
  await keeper.click('[data-check="edit"]');
  await keeper.until('the edit dialog', `/Edit member/.test(document.querySelector('.dialog h2')?.textContent ?? '')`);
  await keeper.shot('5-edit');
  await keeper.fill('.dialog input[type="text"]', 'Pat Leigh');
  await keeper.fill('.dialog input[type="tel"]', '555-0111');
  await keeper.click('.dialog .dialog-actions button:not(.ghost)');
  expect(await untilRows('the edit', LIST, (r) => r.find((x) => x.id === pat.id && x.cells.name === 'Pat Leigh' && x.cells.phone === '555-0111' && x.cells.role === 'Guest' && x.cells.email === 'pat@example.com')), 'an edit is kept, the role and email as they were');
  expect(await keeper.until('the edit to draw', `!!${named('Pat Leigh')} && !document.querySelector('.dialog')`), 'and drawn, the dialog closed');

  // the phone opens the ways to reach someone
  await keeper.inFrame(`${named('Pat Leigh')}.querySelectorAll('.contact-link')[1].setAttribute('data-check', 'phone'); return true;`);
  await keeper.click('[data-check="phone"]');
  expect(await keeper.until('the contact card', `/555-0111/.test(document.querySelector('.contact-modal__number')?.textContent ?? '') && document.querySelectorAll('.contact-action').length === 2`), 'a phone number offers Call and Text');
  await keeper.shot('6-contact');
  await keeper.click('.contact-cancel');

  // a row another frame wrote reaches a member's page by the table's own watch
  await seed(LIST, 'elsewhere1', { name: 'Zed Other', email: 'zed@example.com', phone: '', role: 'Member', _created_at: 9, _modified_at: 9 });
  expect(await keeper.until('the row from elsewhere', `!!${named('Zed Other')}`), "a row written from elsewhere arrives at the keeper's page");

  // settings are the owner's
  await keeper.click('.header-actions button');
  await keeper.until('the settings', `/Settings/.test(document.querySelector('.dialog h2')?.textContent ?? '')`);
  await keeper.fill('.dialog input[type="text"]', 'Rowing Club');
  await keeper.inFrame(`const t = document.querySelector('.dialog textarea'); t.value = 'Captain\\nMember\\nGuest'; t.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await keeper.shot('7-settings');
  await keeper.click('.dialog .dialog-actions button:not(.ghost)');
  expect(await keeper.until('the name to follow', `document.querySelector('.page-header h1').textContent === 'Rowing Club' && !document.querySelector('.dialog')`), 'the organization is named');
  expect(await keeper.until('the roles to follow', `[...document.querySelectorAll('.compose select option')].map((o) => o.value).join() === 'Captain,Member,Guest'`), 'and its roles are the ones set');
  expect(await keeper.until('the legacy role', `/Admin \\(legacy\\)/.test(${named('Ann Ames')}?.querySelector('.role-select')?.innerText ?? '')`), 'a role no longer listed is kept and marked');
  expect(await visitor.until('the name to arrive', `document.querySelector('.page-header h1').textContent === 'Rowing Club'`), "and the stranger's page follows");
  await keeper.shot('8-named');

  // remove
  await keeper.inFrame(`${named('Zed Other')}.querySelector('.delete').setAttribute('data-check', 'delete'); return true;`);
  await keeper.click('[data-check="delete"]');
  expect(await keeper.until('to be asked', `/Remove Zed Other\\?/.test(document.body.innerText)`), 'removing asks first');
  await keeper.click('.framelib-btn-danger');
  expect(await untilRows('the row to go', LIST, (r) => !r.some((x) => x.id === 'elsewhere1') && r.length === 2), 'a member removed is gone from the list');
  expect(await keeper.until('the roster to follow', `!${named('Zed Other')} && document.querySelector('.badge').textContent === '2'`), 'and from the page');
  expect(await visitor.until('the stranger to follow', `document.querySelectorAll('.public-row').length === 2`), "and from the stranger's");

  // another list: the space's lists are offered with how many each holds
  await keeper.click('.list-line__change');
  expect(await keeper.until('the lists', `/club\\.members\\.table\\.jsonl · 2 people · in use/.test(document.querySelector('.framelib-choose')?.innerText ?? '')`), "Change offers the space's lists, the one in use marked");
  await keeper.shot('9-change');
  await keeper.inFrame(`[...document.querySelectorAll('.framelib-choose-opt')].find((o) => /New list/.test(o.innerText)).setAttribute('data-check', 'new'); return true;`);
  await keeper.click('[data-check="new"]');
  await keeper.until('the name to be asked', `!!document.querySelector('.framelib-prompt-input')`);
  await keeper.click('.framelib-btn-primary');
  expect(await keeper.until('the plain list', `document.querySelector('.list-line strong')?.textContent === 'members' && /No members yet/.test(document.body.innerText)`), "a blank name is the space's plain members list, empty");
  expect(await visitor.until('the stranger to follow', `/No members yet/.test(document.body.innerText) && !document.querySelector('.public-row')`), "and the stranger's page reads the list now chosen");
  await add('Sam Moss', 'sam@example.com', '', 'Member');
  expect(await untilRows('the member', 'members', (r) => r.find((x) => x.cells.email === 'sam@example.com')), 'a member added lands in the list now chosen');
  expect((await rows(LIST)).length === 2, 'and the other list is as it was');
  await keeper.shot('10-members');
};
