// Weather Info in the viewer: the keeper searching, a stranger at the published address.
// The forecast comes from open-meteo, so what a lookup shows depends on the network: run
// with HTTPS_PROXY pointed at a closed port and every lookup takes the offline path.

const settled = `(() => {
  const e = document.getElementById('error');
  if (e.style.display === 'block' && e.textContent) return 'error:' + e.textContent;
  const u = document.getElementById('updated').textContent;
  return /^Updated/.test(u) && document.getElementById('location-label').textContent ? 'shown:' + document.getElementById('location-label').textContent : '';
})()`;

async function lookedUp(b, expect, what) {
  const got = await b.until(what, settled);
  if (!got) return null;
  if (got.startsWith('error:')) {
    expect(!/Missing/.test(got) && (await b.inFrame(`return document.getElementById('forecast').children.length`)) === 0, `${what}: open-meteo not reached, and the page says so in the worker's words (${got.slice(6, 80)})`);
  } else {
    expect((await b.inFrame(`return document.querySelectorAll('#forecast .day').length`)) === 5 && /°$/.test(await b.inFrame(`return document.getElementById('cur-temp').textContent`)), `${what}: the forecast draws (${got.slice(6)})`);
  }
  return got;
}

export default async ({ keeper, visitor: open, expect, sleep }) => {
  if (!await keeper.until('the search row', `!!document.getElementById('location-input')`)) return;
  expect(await keeper.inFrame(`return getComputedStyle(document.body).display === 'flex' && getComputedStyle(document.getElementById('search-row')).display === 'flex'`), 'the page has its style');
  expect(await keeper.until('the default place', `document.getElementById('location-input').value === '98102'`), 'a first visit starts from the default place');
  await lookedUp(keeper, expect, 'the default place');
  await keeper.shot('1-first-visit');

  await keeper.clear('#location-input');
  const before = await keeper.inFrame(`return document.getElementById('updated').textContent`);
  await keeper.click('#search-btn');
  await sleep(500);
  expect(await keeper.inFrame(`return document.getElementById('updated').textContent`) === before, 'Search with nothing typed asks nothing');

  await keeper.fill('#location-input', 'Oslo');
  await keeper.press('Enter');
  expect(await keeper.until('the lookup to begin', `document.getElementById('updated').textContent === 'Fetching forecast...' || ${settled}`), 'Enter looks the place up');
  const oslo = await lookedUp(keeper, expect, 'Oslo');
  await keeper.shot('2-oslo');
  if (oslo?.startsWith('shown:')) {
    expect(await keeper.inFrame(`return window.seamside.prefs.get('weather_location')`) === 'Oslo', 'a place found is remembered by this browser');
  }

  // what this browser remembers is where the next visit starts; a page seated with no
  // origin of its own (the sandbox) has storage for one document only, and starts over
  const kept = await keeper.inFrame(`await window.seamside.prefs.set('weather_location', 'Reykjavik'); return location.origin !== 'null' && await window.seamside.prefs.get('weather_location');`);
  await keeper.send('Page.reload');
  keeper.child = null;
  for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
  const want = kept === 'Reykjavik' ? 'Reykjavik' : '98102';
  expect(await keeper.until('the page again', `document.getElementById('location-input')?.value === ${JSON.stringify(want)}`), kept === 'Reykjavik' ? 'the page opens on the place this browser remembered' : 'a page with no origin of its own opens on the default place again');
  await lookedUp(keeper, expect, 'the remembered place');
  await keeper.shot('3-again');

  const visitor = await open();
  if (!await visitor.until('the page for a stranger', `!!document.getElementById('location-input')`)) return;
  await lookedUp(visitor, expect, "a stranger's first visit");
  await visitor.fill('#location-input', 'Lima');
  await visitor.click('#search-btn');
  await lookedUp(visitor, expect, "a stranger's search");
  expect(!await visitor.inFrame(`return /Missing/.test(document.body.textContent)`), 'a stranger is answered like anyone else');
  await visitor.shot('4-stranger');
};
