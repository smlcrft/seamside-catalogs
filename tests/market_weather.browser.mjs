// Market Weather in the viewer: the keeper sets up the market's weekly events, a stranger
// at the published address is shown nothing. No location is set, so nothing here reaches
// Open-Meteo: the live forecast is not driven by these steps.

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
  const setField = (b, sel, value, event = 'change') => b.inFrame(`
    const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('${event}', { bubbles: true })); return true;`);

  if (!await keeper.until('the page to draw', `/Set your market's location in settings/.test(${text('#setup-text')})`)) return;
  expect(await keeper.inFrame(`return ${shown('#settings-btn')} && !(${shown('#view-toggle')}) && !(${shown('#reading')})`), 'an editor with no location is told to set one, and offered settings');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.page-header')).display !== 'block' && document.styleSheets.length >= 2`), 'the page has its style');
  await keeper.shot('1-no-location');

  // ----- a stranger at the published address
  const visitor = await open();
  if (!await visitor.until('the lock', `/Market Weather is a private frame/.test(document.body.textContent)`)) return;
  expect(await visitor.inFrame(`return !document.querySelector('#settings-btn') && !document.querySelector('#events-grid')`), 'a stranger is shown nothing of the market');
  await visitor.shot('2-stranger');

  // ----- two events, then one taken out before saving
  await keeper.click('#settings-btn');
  expect(await keeper.until('the settings', shown('#settings-overlay')), 'settings open');
  await keeper.click('#cfg-event-add');
  expect(await keeper.until('a new event row', `document.querySelectorAll('#cfg-events .event-row').length === 1`), 'Add event adds a row');
  expect(await keeper.inFrame(`const r = document.querySelector('.event-row'); return r.querySelector('.ev-dow').value === '6' && r.querySelector('.ev-start').value === '10:00' && r.querySelector('.ev-end').value === '14:00' && document.activeElement === r.querySelector('.ev-name');`), 'a new event starts Saturday 10–2, its name in focus');
  await keeper.fill('.event-row .ev-name', 'Baking Day');
  await setField(keeper, '.event-row .ev-dow', '0');
  await setField(keeper, '.event-row .ev-start', '09:30');
  await setField(keeper, '.event-row .ev-end', '13:00');
  await keeper.click('#cfg-event-add');
  await keeper.until('a second row', `document.querySelectorAll('#cfg-events .event-row').length === 2`);
  await keeper.fill('.event-row:nth-child(2) .ev-name', 'Scratch');
  await keeper.click('.event-row:nth-child(2) .ev-del');
  expect(await keeper.until('one row left', `document.querySelectorAll('#cfg-events .event-row').length === 1 && document.querySelector('.ev-name').value === 'Baking Day'`), 'a row taken out goes, and the other keeps what was typed');
  await keeper.shot('3-settings');
  await keeper.click('#settings-save');
  expect(await keeper.until('the settings to close', `!(${shown('#settings-overlay')})`), 'Save closes the settings');
  const saved = await untilKept('the event', (v) => v?.events?.length === 1);
  const ev = saved?.events?.[0];
  expect(saved?.location === '' && ev?.name === 'Baking Day' && ev.day_of_week === 0 && ev.start_hh === 9 && ev.start_mm === 30 && ev.end_hh === 13 && ev.end_mm === 0 && /^ev_/.test(ev.id), "the market is kept in the shape it always had");

  // ----- cancel keeps nothing
  await keeper.click('#settings-btn');
  await keeper.until('the settings again', shown('#settings-overlay'));
  expect(await keeper.inFrame(`const r = document.querySelectorAll('.event-row'); return r.length === 1 && r[0].querySelector('.ev-name').value === 'Baking Day' && r[0].querySelector('.ev-dow').value === '0' && r[0].querySelector('.ev-start').value === '09:30';`), 'the settings open on what was kept');
  await keeper.clear('.event-row .ev-name');
  await keeper.fill('.event-row .ev-name', 'Not this');
  await keeper.fill('#cfg-location', 'Nowhere');
  await keeper.click('#settings-cancel');
  expect(await keeper.until('the settings to close', `!(${shown('#settings-overlay')})`), 'Cancel closes the settings');
  await sleep(500);
  const after = await kept();
  expect(after?.events?.[0]?.name === 'Baking Day' && after?.location === '', 'and what was typed there is kept nowhere');
  await keeper.click('#settings-btn');
  await keeper.until('the settings again', shown('#settings-overlay'));
  expect(await keeper.inFrame(`return document.querySelector('.ev-name').value === 'Baking Day' && document.querySelector('#cfg-location').value === ''`), 'nor shown again');
  await keeper.click('#settings-close');
  await keeper.shot('4-kept');

  expect(await visitor.inFrame(`return /Market Weather is a private frame/.test(document.body.textContent) && !/Baking Day/.test(document.body.textContent)`), 'the stranger is still shown nothing');
};
