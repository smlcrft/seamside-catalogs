// Checklist in the viewer: the keeper editing the list, a stranger following along.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  const text = (i) => `document.querySelectorAll('.item')[${i}]?.querySelector('.text input, .text .static')`;
  const shown = (i) => `(${text(i)}?.value ?? ${text(i)}?.textContent)`;

  if (!await keeper.until('the list to draw', `!!document.querySelector('main .new input')`)) return;
  expect(await keeper.inFrame(`return /Nothing on the list/.test(document.querySelector('main').textContent)`), 'the keeper has an empty list and the box to start it');
  expect(await keeper.inFrame(`return !document.querySelector('form') && !document.querySelector('.banner')`), 'the page holds no form and no read-only banner');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('main')).display === 'flex' && getComputedStyle(document.querySelector('.new')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-empty');

  // an item an installed copy left behind, then one typed with Enter
  await seed('checklist', 'old1', { text: 'Water the plants', state: 2, sort_order: 0, created_ms: 5, actor_id: 'did:old', actor_name: 'Ana', _created_at: 5, _modified_at: 5 });
  await keeper.fill('.new input', 'Buy milk');
  await keeper.press('Enter');
  const milk = await untilRows('the task', 'checklist', (r) => r.find((x) => x.cells.text === 'Buy milk'));
  expect(milk?.cells.state === 0 && milk?.cells.sort_order === 1 && milk?.cells.actor_id === '' && milk?.cells._created_at && milk?.cells._modified_at, 'Enter adds a task, last, a row of the space in its old shape');
  expect(await keeper.until('both to draw', `${shown(0)} === 'Water the plants' && ${shown(1)} === 'Buy milk'`), 'and the list draws it after the one left behind');
  expect(await keeper.inFrame(`return /Completed by Ana/.test(document.querySelectorAll('.item')[0].textContent) && document.querySelector('.new input').value === ''`), 'the old item keeps its credit, and the box is cleared');

  // one more, added by leaving the box
  await keeper.fill('.new input', 'Sweep the porch');
  await keeper.inFrame(`document.querySelector('.new input').blur(); return true;`);
  expect(await untilRows('the second task', 'checklist', (r) => r.find((x) => x.cells.text === 'Sweep the porch' && x.cells.sort_order === 2)), 'leaving the box adds what was typed');
  expect(await keeper.until('it to draw', `${shown(2)} === 'Sweep the porch'`), 'and it is drawn last');
  await sleep(300);
  expect((await rows('checklist')).length === 3, 'nothing is added twice');

  // the status cycles: in progress, complete, back
  const status = (i) => `.item:nth-child(${i + 1}) .status`;
  await keeper.click(status(1));
  const started = await untilRows('the start', 'checklist', (r) => r.find((x) => x.id === milk?.id && x.cells.state === 1));
  expect(started?.cells.actor_id?.startsWith('did:') && started?.cells.actor_name && started?.cells.text === 'Buy milk', 'a click starts it, credited to whoever clicked, over the row');
  expect(await keeper.until('the byline', `/In progress ·/.test(document.querySelectorAll('.item')[1].textContent) && !!document.querySelector('${status(1)}.s1')`), 'and the page says it is in progress');
  await keeper.click(status(1));
  expect(await untilRows('the completion', 'checklist', (r) => r.find((x) => x.id === milk?.id && x.cells.state === 2)), 'a second click completes it');
  expect(await keeper.until('the completed byline', `/Completed by/.test(document.querySelectorAll('.item')[1].textContent)`), 'and the page says who completed it');
  await keeper.click(status(1));
  expect(await untilRows('the reset', 'checklist', (r) => r.find((x) => x.id === milk?.id && x.cells.state === 0 && x.cells.actor_name === '' && x.cells.actor_id === '')), 'a third click starts it over and clears the credit');
  await keeper.click(status(1));
  await untilRows('it started again', 'checklist', (r) => r.find((x) => x.id === milk?.id && x.cells.state === 1));
  await keeper.shot('2-list');

  // a rename, saved on Enter
  await keeper.fill('.item:nth-child(2) .text input', 'Buy oat milk');
  await keeper.press('Enter');
  expect(await untilRows('the rename', 'checklist', (r) => r.find((x) => x.id === milk?.id && x.cells.text === 'Buy oat milk' && x.cells.state === 1)), 'a task is renamed on Enter, keeping its state');

  // a stranger at the published address follows along, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the list to draw for a stranger', `document.querySelectorAll('.item').length === 3`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && /viewing this list publicly/.test(document.querySelector('.banner')?.textContent ?? '')`), 'a stranger is told the list is theirs to view');
  expect(await visitor.inFrame(`return !document.querySelector('.new') && !document.querySelector('.trash') && !document.querySelector('.grip') && !document.querySelector('.text input') && [...document.querySelectorAll('.status')].every((b) => b.disabled)`), 'and has no box, no delete, no handle and no status to press');
  expect(await visitor.inFrame(`return ${shown(1)} === 'Buy oat milk' && /In progress ·/.test(document.querySelectorAll('.item')[1].textContent)`), 'the stranger sees the list as it stands');
  await visitor.shot('3-stranger');
  await visitor.click(status(0));
  await sleep(400);
  expect((await rows('checklist')).find((x) => x.id === 'old1')?.cells.state === 2, "a stranger's click changes nothing");

  // nobody touches the stranger's page: the push says to read again
  await keeper.fill('.new input', 'Fix the gate');
  await keeper.press('Enter');
  expect(await untilRows('the new task', 'checklist', (r) => r.find((x) => x.cells.text === 'Fix the gate')), 'the keeper adds a task');
  expect(await visitor.until('it to reach the stranger', `${shown(3)} === 'Fix the gate'`), "and the stranger's open page is told to read again");

  // drag the last task to the top
  await keeper.inFrame(`
    const grips = document.querySelectorAll('.item .grip'), list = document.querySelector('.list');
    const dt = new DataTransfer();
    grips[3].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const top = document.querySelectorAll('.item')[0].getBoundingClientRect().top + 2;
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: top, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: top, dataTransfer: dt }));
    grips[3].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;`);
  const order = (r) => [...r].sort((a, b) => a.cells.sort_order - b.cells.sort_order).map((x) => x.cells.text).join('|');
  expect(await untilRows('the new order', 'checklist', (r) => order(r) === 'Fix the gate|Water the plants|Buy oat milk|Sweep the porch'), 'a task dragged to the top is kept there');
  expect(await keeper.until('the page to follow', `${shown(0)} === 'Fix the gate' && ${shown(1)} === 'Water the plants'`), 'and drawn there');
  expect(await visitor.until('the stranger to follow', `${shown(0)} === 'Fix the gate'`), 'and the stranger sees the new order');

  // delete asks for a second click
  await keeper.click('.item:nth-child(4) .trash');
  expect(await keeper.until('the arming', `!!document.querySelector('.item:nth-child(4) .trash.armed')`), 'one click on delete arms it');
  await sleep(300);
  expect((await rows('checklist')).some((x) => x.cells.text === 'Sweep the porch'), 'and deletes nothing yet');
  await keeper.shot('4-armed');
  await keeper.click('.item:nth-child(4) .trash.armed');
  expect(await untilRows('the delete', 'checklist', (r) => r.length === 3 && !r.some((x) => x.cells.text === 'Sweep the porch')), 'a second click deletes it');
  expect(await keeper.until('it to go', `document.querySelectorAll('.item').length === 3`), 'and it is gone from the page');
  expect(await visitor.until('it to go for the stranger', `document.querySelectorAll('.item').length === 3`), 'and from the stranger\'s');
  await keeper.shot('5-after');
  await visitor.shot('6-stranger-after');
};
