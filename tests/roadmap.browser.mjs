// Roadmap in the viewer: the keeper planning milestones and tasks, a stranger following along.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  // Mark the one element a selector cannot name, by what it says.
  const mark = (b, sel, text, as) => b.inFrame(`
    document.querySelectorAll('[data-t="${as}"]').forEach((n) => n.removeAttribute('data-t'));
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((n) => n.textContent.includes(${JSON.stringify(text)}));
    if (el) el.setAttribute('data-t', '${as}');
    return !!el;`);
  const card = (title) => `[...document.querySelectorAll('.ms')].find((n) => n.querySelector('.ms-title')?.textContent.includes(${JSON.stringify(title)}) || n.querySelector('.ms-title input')?.value === ${JSON.stringify(title)})`;
  const markCard = (b, title, as) => b.inFrame(`
    document.querySelectorAll('[data-t="${as}"]').forEach((n) => n.removeAttribute('data-t'));
    const el = ${card(title)}; if (el) el.setAttribute('data-t', '${as}'); return !!el;`);

  if (!await keeper.until('the roadmap to draw', `!!document.querySelector('main .titlebar')`)) return;
  expect(await keeper.inFrame(`return document.querySelector('.proj-name input')?.placeholder === 'Untitled Roadmap' && /Back Burner/.test(document.querySelector('main').textContent) && /Maybe Later/.test(document.querySelector('main').textContent)`), 'the keeper has an empty roadmap, its name to give and the two buckets');
  expect(await keeper.inFrame(`return !document.querySelector('main').classList.contains('read-only') && !!document.querySelector('.gear') && document.querySelector('.mode').textContent !== 'viewer'`), 'and the full page, not the read-only one');
  expect(await keeper.inFrame(`return !document.querySelector('form') && getComputedStyle(document.querySelector('main')).display === 'flex'`), 'the page holds no form and has its style');
  await keeper.shot('1-empty');

  // the project's name, saved on Enter
  await keeper.fill('.proj-name input', 'Spring launch');
  await keeper.press('Enter');
  const named = await untilRows('the name', '_fdata/roadmap_settings', (r) => r.find((x) => x.id === 'roadmap_name'));
  expect(named?.cells.v === '"Spring launch"' && named?.cells._created_at, 'the name is a row of roadmap_settings, JSON under v');
  expect(await untilRows('the buckets', '_fdata/roadmap_milestones', (r) => r.some((x) => x.id === 'bucket:backburner' && x.cells.completed_ms === 0)), 'and the first write made the two buckets');

  // a milestone, dated
  await mark(keeper, '.row-actions .btn', 'Add milestone', 'addms');
  await keeper.click('[data-t="addms"]');
  if (!await keeper.until('the new milestone row', `!!document.querySelector('.row-actions .set-input')`)) return;
  await keeper.fill('.row-actions .set-input', 'Beta');
  await keeper.inFrame(`const d = document.querySelector('.row-actions .ms-date input'); d.value = '2031-03-14'; d.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await mark(keeper, '.row-actions .btn', 'Add', 'addbtn');
  await keeper.click('[data-t="addbtn"]');
  const beta = await untilRows('the milestone', '_fdata/roadmap_milestones', (r) => r.find((x) => x.cells.title === 'Beta'));
  expect(beta?.cells.kind === 'milestone' && new Date(beta?.cells.target_ms).getFullYear() === 2031 && beta?.cells.completed === 0 && beta?.cells.completed_ms === 0 && beta?.cells._created_at, 'Add makes a dated milestone, a row in its old shape');
  expect(await keeper.until('it to draw', `!!(${card('Beta')}) && /in \\d+d/.test((${card('Beta')}).textContent)`), 'and it is drawn with the days left');

  // tasks: one typed, then a pasted list
  await markCard(keeper, 'Beta', 'beta');
  await keeper.fill('[data-t="beta"] .task-new-input', 'Write docs');
  await keeper.press('Enter');
  const docs = await untilRows('the task', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Write docs'));
  expect(docs?.cells.milestone_id === beta?.id && docs?.cells.state === 0 && docs?.cells.sort_order === 0 && docs?.cells.actor_id === '' && docs?.cells.completed_ms === 0, 'Enter adds a task to its milestone, from the defaults');
  await keeper.inFrame(`
    const el = document.querySelector('[data-t="beta"] .task-new-input'); el.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', 'Ship build\\n\\nTest it\\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;`);
  const three = await untilRows('the pasted list', '_fdata/roadmap_tasks', (r) => r.length === 3 && r);
  expect(three && three.find((x) => x.cells.text === 'Ship build')?.cells.sort_order === 1 && three.find((x) => x.cells.text === 'Test it')?.cells.sort_order === 2, 'a pasted list is a task a line, in order');
  expect(await keeper.until('all three to draw', `(${card('Beta')})?.querySelectorAll('.task').length === 3`), 'and all three are drawn');
  expect(await keeper.inFrame(`return /Spring launch/.test(document.querySelector('.proj-name input').value)`), 'the name stayed as typed');

  // the status cycles, credited to whoever clicked
  await markCard(keeper, 'Beta', 'beta');
  await keeper.click('[data-t="beta"] .task:nth-child(1) .tstatus');
  const started = await untilRows('the start', '_fdata/roadmap_tasks', (r) => r.find((x) => x.id === docs?.id && x.cells.state === 1));
  expect(started?.cells.actor_id?.startsWith('did:') && started?.cells.completed_ms === 0, 'a click starts a task, credited to the keeper by their ID');
  expect(await keeper.until('the byline', `!!document.querySelector('[data-t="beta"] .task:nth-child(1) .tby.s1')`), 'and the page says who has it');
  await keeper.click('[data-t="beta"] .task:nth-child(1) .tstatus');
  const finished = await untilRows('the completion', '_fdata/roadmap_tasks', (r) => r.find((x) => x.id === docs?.id && x.cells.state === 2));
  expect(finished?.cells.completed_ms > 0, 'a second click completes it, stamped for the burn rate');
  expect(await keeper.until('the burn rate', `/\\/d/.test((${card('Beta')}).querySelector('.burn')?.textContent ?? '')`), 'and the header shows a burn rate');

  // a milestone with open tasks will not complete
  await markCard(keeper, 'Beta', 'beta');
  await keeper.click('[data-t="beta"] .ms-check');
  expect(await keeper.until('the refusal', `/All tasks must be done/.test(document.querySelector('.framelib-dialog-host')?.textContent ?? '')`), 'completing a milestone with open tasks is refused, in so many words');
  await keeper.shot('2-not-done');
  await keeper.click('.framelib-dialog-host .framelib-btn-primary');
  await sleep(300);
  expect((await rows('_fdata/roadmap_milestones')).find((x) => x.id === beta?.id)?.cells.completed === 0, 'and nothing changed');

  // a task renamed in place
  await markCard(keeper, 'Beta', 'beta');
  await keeper.click('[data-t="beta"] .task:nth-child(2) .ttext-view');
  if (!await keeper.until('the editor', `!!document.querySelector('.ttext-edit')`)) return;
  await keeper.fill('.ttext-edit', 'Ship the build');
  await keeper.press('Enter');
  expect(await untilRows('the rename', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Ship the build' && x.cells.sort_order === 1)), 'a task is renamed on Enter');
  expect(await keeper.until('it to draw', `JSON.stringify([...(${card('Beta')}).querySelectorAll('.ttext-view')].map((n) => n.textContent)) === JSON.stringify(['Write docs', 'Ship the build', 'Test it'])`), 'and drawn renamed');

  // a stranger at the published address follows along, and changes nothing
  const visitor = await open();
  if (!await visitor.until('the roadmap to draw for a stranger', `(${card('Beta')})?.querySelectorAll('.task').length === 3`)) return;
  expect(await visitor.inFrame(`return document.querySelector('main').classList.contains('read-only') && document.querySelector('.mode').textContent === 'viewer' && /Spring launch/.test(document.querySelector('.proj-name').textContent)`), 'a stranger is shown the roadmap read-only, named');
  expect(await visitor.inFrame(`return !document.querySelector('.task-new') && !document.querySelector('.grip') && !document.querySelector('.ttrash') && !document.querySelector('.ms-check') && !document.querySelector('.gear') && [...document.querySelectorAll('.tstatus')].every((b) => b.disabled)`), 'with no box, handle, delete, check, settings or status to press');
  await visitor.shot('3-stranger');
  await visitor.inFrame(`document.querySelectorAll('.tstatus')[1].click(); return true;`);
  await sleep(400);
  expect((await rows('_fdata/roadmap_tasks')).find((x) => x.cells.text === 'Ship the build')?.cells.state === 0, "a stranger's click changes nothing");

  // the keeper's change reaches the stranger's open page
  await markCard(keeper, 'Beta', 'beta');
  await keeper.fill('[data-t="beta"] .task-new-input', 'Tell the press');
  await keeper.press('Enter');
  expect(await untilRows('the fourth task', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Tell the press')), 'the keeper adds a task');
  expect(await visitor.until('it to reach the stranger', `(${card('Beta')})?.querySelectorAll('.task').length === 4`), "and the stranger's page is told to read again");

  // a task dragged to the back burner
  await keeper.inFrame(`
    const from = ${card('Beta')}, to = ${card('Back Burner')};
    const grip = [...from.querySelectorAll('.task')].find((n) => n.textContent.includes('Tell the press')).querySelector('.grip');
    const list = to.querySelector('.tasks'), dt = new DataTransfer();
    const y = list.getBoundingClientRect().top + 4;
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
    grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;`);
  expect(await untilRows('the move', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Tell the press' && x.cells.milestone_id === 'bucket:backburner' && x.cells.sort_order === 0)), 'a task dragged to the back burner is kept there');
  expect(await keeper.until('the page to follow', `JSON.stringify([...(${card('Back Burner')}).querySelectorAll('.ttext-view')].map((n) => n.textContent)) === '["Tell the press"]'`), 'and drawn there');
  expect(await visitor.until('the stranger to follow', `(${card('Back Burner')})?.querySelectorAll('.task').length === 1`), 'and the stranger sees it moved');

  // a task dragged to the top of its milestone
  await keeper.inFrame(`
    const list = (${card('Beta')}).querySelector('.tasks'), rows = list.querySelectorAll('.task');
    const grip = rows[2].querySelector('.grip'), dt = new DataTransfer();
    const y = rows[0].getBoundingClientRect().top + 2;
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
    grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;`);
  const order = (r) => r.filter((x) => x.cells.milestone_id === beta?.id).sort((a, b) => a.cells.sort_order - b.cells.sort_order).map((x) => x.cells.text).join('|');
  expect(await untilRows('the new order', '_fdata/roadmap_tasks', (r) => order(r) === 'Test it|Write docs|Ship the build'), 'a task dragged to the top is ranked there');
  expect(await keeper.until('the page to rank it', `JSON.stringify([...(${card('Beta')}).querySelectorAll('.ttext-view')].map((n) => n.textContent)) === JSON.stringify(['Test it', 'Write docs', 'Ship the build'])`), 'and drawn there');

  // delete a task: a second click does it
  await markCard(keeper, 'Beta', 'beta');
  await keeper.click('[data-t="beta"] .task:nth-child(1) .ttrash');
  expect(await keeper.until('the arming', `!!document.querySelector('[data-t="beta"] .task:nth-child(1) .ttrash.armed')`), 'one click on delete arms it');
  await sleep(300);
  expect((await rows('_fdata/roadmap_tasks')).some((x) => x.cells.text === 'Test it'), 'and deletes nothing yet');
  await keeper.click('[data-t="beta"] .task:nth-child(1) .ttrash.armed');
  expect(await untilRows('the delete', '_fdata/roadmap_tasks', (r) => !r.some((x) => x.cells.text === 'Test it')), 'a second click deletes it');

  // finish the rest, then the milestone completes
  await markCard(keeper, 'Beta', 'beta');
  await keeper.click('[data-t="beta"] .task:nth-child(2) .tstatus');
  await untilRows('started', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Ship the build' && x.cells.state === 1));
  await keeper.click('[data-t="beta"] .task:nth-child(2) .tstatus');
  await untilRows('done', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Ship the build' && x.cells.state === 2));
  if (!await keeper.until('the check to unlock', `!!document.querySelector('[data-t="beta"] .ms-check:not(.locked)')`)) return;
  await keeper.click('[data-t="beta"] .ms-check');
  const done = await untilRows('the completed milestone', '_fdata/roadmap_milestones', (r) => r.find((x) => x.id === beta?.id && x.cells.completed === 1));
  expect(done?.cells.completed_ms > 0 && done?.cells._created_at === beta?.cells._created_at, 'with every task done the milestone completes, over its row');
  expect(await keeper.until('it to fold away', `!(${card('Beta')}) && /Show 1 completed/.test(document.querySelector('.row-actions').textContent)`), 'and folds away behind Show 1 completed');
  await mark(keeper, '.row-actions .btn', 'Show 1 completed', 'show');
  await keeper.click('[data-t="show"]');
  expect(await keeper.until('the completed milestone to show', `/completed milestones/.test(document.querySelector('.lane').textContent) && !!(${card('Beta')})?.querySelector('.chip.done')`), 'which shows it, done');
  await keeper.shot('4-done');

  // the project settings: a quick link
  await keeper.click('.gear');
  if (!await keeper.until('the settings', `/Project settings/.test(document.querySelector('.framelib-modal h2')?.textContent ?? '') && !!document.querySelector('.set-field input')`)) return;
  await mark(keeper, '.set-field .btn', 'Add link', 'addlink');
  await keeper.click('[data-t="addlink"]');
  await keeper.fill('.link-edit .set-input.lbl', 'Board');
  await keeper.fill('.link-edit .set-input:not(.lbl)', 'https://example.com/board');
  await keeper.shot('5-settings');
  await mark(keeper, 'button', 'Save', 'save');
  await keeper.click('[data-t="save"]');
  const links = await untilRows('the links', '_fdata/roadmap_settings', (r) => r.find((x) => x.id === 'roadmap_links' && /board/.test(x.cells.v)));
  expect(links && JSON.parse(links.cells.v)[0]?.url === 'https://example.com/board', 'Save keeps the link as JSON under v');
  expect(await keeper.until('the chip', `/Board/.test(document.querySelector('.links')?.textContent ?? '') && !document.querySelector('.framelib-modal')`), 'and the page shows it as a chip, the settings closed');
  expect(await visitor.until('the chip for the stranger', `/Board/.test(document.querySelector('.links')?.textContent ?? '')`), 'and the stranger sees it too');

  // a second milestone, and the timeline
  await mark(keeper, '.row-actions .btn', 'Add milestone', 'addms');
  await keeper.click('[data-t="addms"]');
  await keeper.fill('.row-actions .set-input', 'Launch');
  await keeper.press('Enter');
  const launch = await untilRows('the second milestone', '_fdata/roadmap_milestones', (r) => r.find((x) => x.cells.title === 'Launch'));
  expect(launch?.cells.target_ms === null && launch?.cells.sort_order === 1, 'Enter adds an undated milestone after the first');
  expect(await visitor.until('it to reach the stranger', `!!(${card('Launch')})`), 'and the stranger sees it');
  await mark(keeper, '.tab', 'Timeline', 'tl');
  await keeper.click('[data-t="tl"]');
  expect(await keeper.until('the timeline', `[...document.querySelectorAll('.tl-title')].map((n) => n.textContent).join('|') === 'Beta|Launch' && /unscheduled/.test(document.querySelector('.timeline').textContent)`), 'the timeline lays out the dated milestone and the unscheduled one');
  await keeper.shot('6-timeline');
  await mark(keeper, '.tab', 'Board', 'board');
  await keeper.click('[data-t="board"]');

  // a milestone with tasks is deleted after asking
  await markCard(keeper, 'Launch', 'launch');
  await keeper.fill('[data-t="launch"] .task-new-input', 'Book the hall');
  await keeper.press('Enter');
  await untilRows('its task', '_fdata/roadmap_tasks', (r) => r.find((x) => x.cells.text === 'Book the hall'));
  await markCard(keeper, 'Launch', 'launch');
  await keeper.click('[data-t="launch"] .ms-del');
  await keeper.click('[data-t="launch"] .ms-del.armed');
  expect(await keeper.until('the confirm', `/Delete “Launch” and its 1 task\\?/.test(document.querySelector('.framelib-prompt-msg')?.textContent ?? '')`), 'deleting a milestone with tasks asks first, with the count');
  await keeper.click('.framelib-btn-danger');
  expect(await untilRows('the deleted milestone', '_fdata/roadmap_milestones', (r) => !r.some((x) => x.cells.title === 'Launch')), 'the milestone is deleted');
  expect(await untilRows('its tasks gone', '_fdata/roadmap_tasks', (r) => !r.some((x) => x.cells.text === 'Book the hall')), 'with its tasks');
  expect(await visitor.until('it to go for the stranger', `!(${card('Launch')})`), "and it is gone from the stranger's page");
  await keeper.shot('7-after');
  await visitor.shot('8-stranger-after');
};
