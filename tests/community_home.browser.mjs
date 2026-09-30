// Community Home in the viewer: the keeper at the builder, a stranger at the page.

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  const enter = async (b) => {
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined }, b.child);
    await sleep(250);
  };
  const row = (n) => `.ch-blocks-editor > .ch-row:nth-child(${n})`;
  // a setting is the session's own: read it back through the frame
  const viaFrame = async (path, test) => {
    for (let i = 0; i < 60; i++) {
      const v = await keeper.inFrame(`const r = await window.seamside.fetch(${JSON.stringify(path)}); return r.ok ? r.json() : null;`);
      if (v && test(v)) return v;
      await sleep(250);
    }
    return null;
  };

  if (!await keeper.until('the builder to draw', `!!document.querySelector('.ch-admin #ch-title')`)) return;
  expect(await keeper.inFrame(`return !document.querySelector('form') && !!document.querySelector('.ch-editor[data-form]')`), 'the builder is no form');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.ch-editor')).display === 'flex' && getComputedStyle(document.querySelector('.ch-admin-header')).display === 'flex'`), 'the page has its style');
  expect(await keeper.inFrame(`return document.querySelector('#ch-title').value === 'Welcome to our community' && document.querySelectorAll('.ch-blocks-editor > .ch-row').length === 1`), 'the keeper opens on the seeded page');
  const seeded = await untilRows('the seeded block', 'community_home_blocks', (r) => r.find((x) => x.id === 'seed_about'));
  expect(seeded?.cells.heading === 'About us' && seeded?.cells.width === 320 && seeded?.cells._created_at > 0, 'the seeded block is a row of the space');
  await keeper.shot('1-builder');

  const visitor = await open();
  if (!await visitor.until('the page to draw', `!!document.querySelector('.ch-public .ch-hero h1')`)) return;
  expect(!await visitor.inFrame(`return !!document.querySelector('.ch-admin') || !!document.querySelector('.ch-preview-bar')`), 'a stranger has the page, no builder and no preview bar');
  expect(await visitor.inFrame(`return document.querySelector('.ch-hero h1').textContent === 'Welcome to our community' && /About us/.test(document.querySelector('.ch-section h2').textContent)`), 'and reads the seeded page');
  await visitor.shot('2-public');

  // the title, by Enter
  await keeper.fill('#ch-title', 'Our street');
  await enter(keeper);
  expect(await viaFrame('/api/page', (s) => s.title === 'Our street'), 'Enter on the title keeps it');
  // the tagline, by leaving the field
  await keeper.fill('#ch-tagline', 'Neighbours, mostly.');
  await keeper.click('.ch-admin-header h1');
  expect(await viaFrame('/api/page', (s) => s.tagline === 'Neighbours, mostly.'), 'leaving the tagline keeps it');
  expect(await visitor.until('the title to arrive by itself', `document.querySelector('.ch-hero h1').textContent === 'Our street' && document.querySelector('.ch-tagline')?.textContent === 'Neighbours, mostly.'`), "the stranger's open page is told and reads again");

  // a section
  await keeper.click('.ch-add-btns button:nth-child(1)');
  const section = await untilRows('the section', 'community_home_blocks', (r) => r.find((x) => x.cells.heading === 'New section'));
  expect(section?.cells.kind === 'section' && section?.cells.format === 'text' && section?.cells.sort_order === 1 && section?.cells.url === '', 'Add section makes a row after the last, from the defaults');
  if (!await keeper.until('the section to list', `document.querySelectorAll('.ch-blocks-editor > .ch-row').length === 2`)) return;
  await keeper.fill(`${row(2)} .ch-row-head input`, 'Meetings');
  await enter(keeper);
  await keeper.fill(`${row(2)} textarea`, 'First Tuesday.');
  await keeper.click('.ch-admin-header h1');
  expect(await untilRows('the section as written', 'community_home_blocks', (r) => r.find((x) => x.id === section?.id && x.cells.heading === 'Meetings' && x.cells.body === 'First Tuesday.' && x.cells.kind === 'section' && x.cells._created_at === section.cells._created_at)), 'a heading and a body land over the row as it was');
  await keeper.click(`${row(2)} .ch-fmt:nth-child(2)`);
  expect(await untilRows('the format', 'community_home_blocks', (r) => r.find((x) => x.id === section?.id && x.cells.format === 'html' && x.cells.body === 'First Tuesday.')), 'HTML chosen is kept');
  expect(await keeper.until('the toggle to follow', `document.querySelector(${JSON.stringify(`${row(2)} .ch-fmt.active`)})?.textContent.trim() === 'HTML' && !!document.querySelector(${JSON.stringify(`${row(2)} textarea.ch-code`)})`), 'and the row shows it');

  // a link
  await keeper.click('.ch-add-btns button:nth-child(2)');
  const link = await untilRows('the link', 'community_home_blocks', (r) => r.find((x) => x.cells.kind === 'link'));
  expect(link?.cells.label === 'New link' && link?.cells.url === 'https://example.com' && link?.cells.sort_order === 2, 'Add link makes a link row');
  if (!await keeper.until('the link to list', `!!document.querySelector('.ch-link-row input[type="url"]')`)) return;
  await keeper.fill('.ch-link-row input[type="text"]', 'Minutes');
  await enter(keeper);
  await keeper.fill('.ch-link-row input[type="url"]', 'not a link');
  await enter(keeper);
  await sleep(500);
  expect((await rows('community_home_blocks')).find((x) => x.id === link?.id)?.cells.url === 'https://example.com', 'Enter on an address that is not one keeps nothing');
  await keeper.fill('.ch-link-row input[type="url"]', 'https://example.com/minutes');
  await enter(keeper);
  expect(await untilRows('the link as written', 'community_home_blocks', (r) => r.find((x) => x.id === link?.id && x.cells.label === 'Minutes' && x.cells.url === 'https://example.com/minutes')), 'a label and an address are kept');
  await keeper.fill('.ch-link-row input[type="url"]', 'ftp://example.com/minutes');
  await enter(keeper);
  expect(await keeper.until('the toast', `/invalid url/.test(document.querySelector('.ch-toast')?.textContent ?? '')`, 12), 'an address the worker refuses is said');
  expect((await rows('community_home_blocks')).find((x) => x.id === link?.id)?.cells.url === 'https://example.com/minutes', 'and not kept');

  // a public frame
  await keeper.click('.ch-add-btns button:nth-child(3)');
  const pub = await untilRows('the public frame', 'community_home_blocks', (r) => r.find((x) => x.cells.kind === 'pub_frame'));
  expect(pub?.cells.url === 'https://example.com' && pub?.cells.width === 320 && pub?.cells.sort_order === 3, 'Add public frame makes its row');
  if (!await keeper.until('the public frame to list', `!!document.querySelector('.ch-pubframe-row')`)) return;
  await keeper.fill('.ch-pubframe-row .ch-row-head input', 'Sign up');
  await enter(keeper);
  expect(await untilRows('its label', 'community_home_blocks', (r) => r.find((x) => x.id === pub?.id && x.cells.heading === 'Sign up')), 'its label is kept');
  await keeper.shot('3-builder-filled');

  // what visitors see
  expect(await visitor.until('the blocks to arrive by themselves', `document.querySelectorAll('.ch-blocks > *').length === 4 && /Sign up/.test(document.querySelector('.ch-blocks').innerText) && /Minutes/.test(document.querySelector('.ch-blocks').innerText)`), "the stranger's page follows, in order");
  expect(await visitor.inFrame(`return document.querySelector('.ch-section-body.is-html')?.textContent === 'First Tuesday.' && document.querySelectorAll('a.ch-link')[0].getAttribute('href') === 'https://example.com/minutes'`), 'with the section and the link as written');
  await visitor.shot('4-public-filled');

  await keeper.click('.ch-admin-header button');
  expect(await keeper.until('the preview', `!!document.querySelector('.ch-preview-bar') && !document.querySelector('.ch-admin') && document.querySelector('.ch-hero h1')?.textContent === 'Our street'`), 'Preview shows the keeper what visitors see');
  await keeper.shot('5-preview');
  await keeper.click('.ch-preview-bar button');
  expect(await keeper.until('the builder again', `!!document.querySelector('.ch-admin') && document.querySelectorAll('.ch-blocks-editor > .ch-row').length === 4`), 'and Back to edit returns');

  // taking a block out
  await keeper.click(`${row(1)} button[title="Remove section"]`);
  expect(await untilRows('the seeded block to go', 'community_home_blocks', (r) => !r.find((x) => x.id === 'seed_about') && r.length === 3), 'Remove takes the row out');
  expect(await keeper.until('the list to follow', `document.querySelectorAll('.ch-blocks-editor > .ch-row').length === 3`), 'and the builder shows it');
  expect(await visitor.until('the page to follow', `document.querySelectorAll('.ch-blocks > *').length === 3 && !/About us/.test(document.body.innerText)`), "and the stranger's page");

  await visitor.send('Page.reload');
  visitor.child = null;
  for (let i = 0; i < 60 && !visitor.child; i++) await sleep(250);
  expect(await visitor.until('the page again', `document.querySelector('.ch-hero h1')?.textContent === 'Our street' && document.querySelectorAll('.ch-blocks > *').length === 3`), 'a visitor who comes back is not seeded over: the page is as it was left');
  await visitor.shot('6-public-again');
};
