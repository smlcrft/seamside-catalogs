// Garden Gnome in the viewer: the keeper setting the garden up, a stranger at the published
// address reading the board without the town. The weather comes from open-meteo, so the steps
// hold with the network unreachable (HTTPS_PROXY pointed at a closed port); the board drawn from
// a real forecast (cards, meters, a risk badge) is checked only with CATALOG_CHECK_ONLINE=1.

const ONLINE = !!process.env.CATALOG_CHECK_ONLINE;

export default async ({ keeper, visitor: open, expect, sleep }) => {
  const shown = (sel) => `!!document.querySelector('${sel}') && !document.querySelector('${sel}').classList.contains('hidden')`;
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '').trim()`;
  // What the worker keeps for this session, asked of it as the keeper: the daemon's copy, not the page's.
  const kept = async () => JSON.parse(await keeper.inFrame(`const r = await window.seamside.fetch('/api/state'); return JSON.stringify(r.ok ? r.json().prefs : null);`) ?? 'null');
  const untilKept = async (what, test) => {
    for (let i = 0; i < 40; i++) { const v = await kept(); if (test(v)) return v; await sleep(250); }
    expect(false, `the session kept ${what}`);
    return null;
  };
  const reload = async (b) => {
    await b.send('Page.reload');
    b.child = null;
    for (let i = 0; i < 60 && !b.child; i++) await sleep(250);
  };
  const checked = (b) => b.inFrame(`return [...document.querySelectorAll('#cfg-plants input:checked')].map((i) => i.value).sort().join(',')`);
  // The board once the weather was asked for: its cards, or the page saying it has none.
  const board = (unavailable) => `document.querySelectorAll('#plants .plant-card').length ? 'cards' : (${shown('#setup-note')} && ${unavailable}.test(${text('#setup-text')}) ? 'none' : '')`;

  if (!await keeper.until('the page to draw', `/Set your location in settings to start fetching weather\\./.test(${text('#setup-text')})`)) return;
  expect(await keeper.inFrame(`return ${shown('#settings-btn')} && !(${shown('#reading')}) && document.querySelectorAll('.plant-card').length === 0`), 'an editor with no location is told to set one, and offered settings');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.page-header')).display !== 'block' && document.styleSheets.length >= 2`), 'the page has its style');
  await keeper.shot('1-not-set-up');

  // ----- a garden saved through the worker, with a plant there is no such thing as
  await keeper.inFrame(`await window.seamside.fetch('/api/save', { method: 'POST', body: JSON.stringify({ location: '', soil: 'clay', plants: ['corn', 'weeds'] }) }); return true;`);
  await reload(keeper);
  if (!await keeper.until('the page again', shown('#settings-btn'))) return;
  await keeper.click('#settings-btn');
  expect(await keeper.until('the settings', shown('#settings-overlay')), 'settings open');
  expect(await keeper.inFrame(`return document.getElementById('cfg-soil').value === 'clay' && /holds onto water/.test(${text('#cfg-soil-desc')}) && document.getElementById('cfg-location').value === ''`), 'the settings open on the soil the worker kept');
  expect(await checked(keeper) === 'corn', 'and its plants, the one there is none of left out');
  await keeper.click('#settings-close');
  expect(await keeper.until('the settings to close', `!(${shown('#settings-overlay')})`), 'the close button closes the settings');

  // ----- a stranger before the garden is set up
  const visitor = await open();
  if (!await visitor.until('the page for a stranger', `/This garden hasn't been set up yet\\./.test(${text('#setup-text')})`)) return;
  expect(await visitor.inFrame(`return !(${shown('#settings-btn')})`), 'a stranger is shown no settings');
  await visitor.shot('2-stranger-not-set-up');

  // ----- the keeper sets the garden up
  await keeper.click('#settings-btn');
  await keeper.until('the settings again', shown('#settings-overlay'));
  await keeper.fill('#cfg-location', 'Portland, Oregon');
  await keeper.inFrame(`const s = document.getElementById('cfg-soil'); s.value = 'sandy'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  expect(await keeper.inFrame(`return /drains fast/.test(${text('#cfg-soil-desc')})`), 'a soil chosen says what it is');
  await keeper.click('#cfg-plants input[value="corn"]');
  await keeper.click('#cfg-plants input[value="tomatoes"]');
  await keeper.click('#cfg-plants input[value="herbs"]');
  expect(await checked(keeper) === 'herbs,tomatoes' && await keeper.inFrame(`return document.querySelectorAll('#cfg-plants .plant-option.checked').length === 2`), 'a plant ticked is chosen, one ticked again is not');
  await keeper.shot('3-settings');
  await keeper.click('#settings-save');
  expect(await keeper.until('the settings to close', `!(${shown('#settings-overlay')})`), 'save closes the settings');
  const saved = await untilKept('the garden', (v) => v?.location === 'Portland, Oregon');
  expect(saved?.soil === 'sandy' && saved?.plants?.slice().sort().join(',') === 'herbs,tomatoes' && Object.keys(saved).join(',') === 'location,soil,plants', "the garden is kept in the shape it always had");

  const mine = await keeper.until('the board', board(/Couldn't find weather for "Portland, Oregon"/));
  if (ONLINE) expect(mine === 'cards', 'open-meteo reached: the board is drawn from the forecast');
  else console.log('  (the board drawn from a real forecast is not checked: set CATALOG_CHECK_ONLINE=1 to check it)');
  if (ONLINE && mine === 'cards') {
    expect(await keeper.inFrame(`return document.querySelectorAll('.plant-card').length === 2 && [...document.querySelectorAll('.plant-name')].map((n) => n.textContent).join(',') === 'Herbs,Tomatoes' && document.querySelectorAll('.plant-card .meter').length === 6`), 'each plant has its three meters, in order of name');
    expect(await keeper.inFrame(`return ${shown('#reading')} && /Portland/.test(${text('#reading-meta-text')}) && /°F/.test(${text('#reading-meta-text')})`), 'the reading names the place for the keeper');
    const badge = await keeper.inFrame(`return !!document.querySelector('.risk-badge')`);
    if (badge) {
      await keeper.click('.risk-badge');
      expect(await keeper.inFrame(`return document.querySelector('.risk-badge').classList.contains('expanded')`), 'a risk badge opens when tapped');
      await keeper.click('.risk-badge');
      expect(await keeper.inFrame(`return !document.querySelector('.risk-badge').classList.contains('expanded')`), 'and closes when tapped again');
    }
  } else if (mine === 'none') {
    expect(await keeper.inFrame(`return document.querySelectorAll('.plant-card').length === 0 && !(${shown('#reading')})`), 'open-meteo not reached: the keeper is told, and shown no board');
  }
  await keeper.shot('4-set-up');

  // nobody touches the stranger's page: the push brings the garden to it, without the town
  const theirs = await visitor.until('the garden to arrive by itself', board(/Weather for this garden is unavailable right now\./));
  expect(!!theirs, "the stranger's open page is told of the change");
  expect(await visitor.inFrame(`return !/Portland|Oregon/.test(document.body.textContent) && !(${shown('#settings-btn')})`), 'a stranger is never shown the town, nor settings');
  if (ONLINE && theirs === 'cards') expect(await visitor.inFrame(`return document.querySelectorAll('.plant-card').length === 2 && ${shown('#reading')}`), 'a stranger reads the same board');
  await visitor.shot('5-stranger-board');

  // ----- cancel keeps nothing
  await keeper.click('#settings-btn');
  await keeper.until('the settings once more', shown('#settings-overlay'));
  expect(await keeper.inFrame(`return document.getElementById('cfg-location').value === 'Portland, Oregon' && document.getElementById('cfg-soil').value === 'sandy'`) && await checked(keeper) === 'herbs,tomatoes', 'the settings open on what was kept');
  await keeper.clear('#cfg-location');
  await keeper.fill('#cfg-location', 'Nowhere');
  await keeper.click('#cfg-plants input[value="herbs"]');
  await keeper.click('#settings-cancel');
  expect(await keeper.until('the settings to close', `!(${shown('#settings-overlay')})`), 'cancel closes the settings');
  await sleep(500);
  const after = await kept();
  expect(after?.location === 'Portland, Oregon' && after?.plants?.length === 2, 'and keeps nothing');

  // a click beside the dialog closes it too, and keeps nothing
  await keeper.click('#settings-btn');
  await keeper.until('the settings', shown('#settings-overlay'));
  expect(await checked(keeper) === 'herbs,tomatoes', 'what was cancelled is not in the settings');
  await keeper.inFrame(`document.getElementById('settings-overlay').click(); return true;`);
  expect(await keeper.until('the settings to close', `!(${shown('#settings-overlay')})`), 'a click beside the dialog closes it');

  // ----- clearing the town takes the board away
  await keeper.click('#settings-btn');
  await keeper.until('the settings', shown('#settings-overlay'));
  await keeper.clear('#cfg-location');
  await keeper.press('Tab');
  await keeper.click('#settings-save');
  await untilKept('no town', (v) => v?.location === '');
  expect(await keeper.until('the page to say it is not set up', `/Set your location in settings/.test(${text('#setup-text')}) && document.querySelectorAll('.plant-card').length === 0`), 'a garden with no town asks for one again');
  expect(await visitor.until("the stranger's page to follow", `/This garden hasn't been set up yet\\./.test(${text('#setup-text')}) && document.querySelectorAll('.plant-card').length === 0`), 'and the stranger is told it is not set up');
  await visitor.shot('6-stranger-cleared');
};
