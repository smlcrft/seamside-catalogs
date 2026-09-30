// Space Radio in the viewer: the keeper picks a station, pauses and plays it and sets their
// own volume; a stranger at the published address listens along and touches nothing.
// Nothing reaches a stream: each page's audio element is stood in for before anything
// plays, and records what it was asked to play. Actual playback is not proven here.

export default async ({ keeper, visitor: open, expect, sleep }) => {
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '').trim()`;
  const sandboxed = !!process.env.CATALOG_CHECK_SANDBOX;
  // What the door keeps for this session, read as the keeper: the daemon's copy, not the page's.
  const kept = async () => JSON.parse(await keeper.inFrame(`return (await window.seamside.kv.get('playstate'))?.value ?? 'null';`) ?? 'null');
  const untilKept = async (what, test) => {
    for (let i = 0; i < 40; i++) { const v = await kept(); if (v && test(v)) return v; await sleep(250); }
    expect(false, `the session kept ${what}`);
    return null;
  };
  // The audio element's play() answers from here, and says what it was asked for.
  const standIn = (b, refuse = false) => b.inFrame(`
    window.__asked = [];
    window.__refuse = ${refuse};
    HTMLMediaElement.prototype.play = function () {
      window.__asked.push(this.src);
      if (window.__refuse) return Promise.reject(new DOMException('no gesture yet', 'NotAllowedError'));
      return Promise.resolve();
    };
    return true;`);
  const asked = (b) => b.inFrame(`return window.__asked.slice();`);
  const audio = (b) => b.inFrame(`const a = document.getElementById('sr-audio'); return { src: a.getAttribute('src') || '', paused: a.paused, volume: a.volume, muted: a.muted };`);
  const choose = (b, id) => b.inFrame(`const s = document.getElementById('sr-station'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);

  if (!await keeper.until('the radio to draw', `${text('.sr-station-name')} === 'No station selected'`)) return;
  await standIn(keeper);
  expect(await keeper.inFrame(`return ${text('.sr-by')} === 'pick a station to play it for everyone' && !document.getElementById('sr-station').disabled && !document.getElementById('sr-play').disabled`), 'the keeper is offered the dial and the play button');
  expect(await keeper.inFrame(`return ${text('.sr-live .label')} === 'idle' && ${text('.sr-footer')} === 'play is shared · volume is yours' && document.querySelectorAll('#sr-station option').length > 80`), 'idle, with every station on the list');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.sr-root')).display === 'flex' && ${text('#sr-vol-readout')} === '15%'`), 'the page has its style, and starts quiet');
  await keeper.shot('1-idle');

  // ----- a station, playing for everyone
  await choose(keeper, 'kexp');
  expect(await untilKept('KEXP, playing', (v) => v.station_id === 'kexp' && v.playing === true && v.updated_by_name === 'user' && v.updated_at > 0), 'choosing a station keeps it for the session, playing');
  expect(await keeper.until('KEXP to draw', `${text('.sr-station-name')} === 'KEXP Seattle' && ${text('.sr-by')} === 'playing by user' && ${text('.sr-live .label')} === 'live'`), 'the keeper sees it live');
  const k1 = await audio(keeper);
  expect(k1.src === 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3' && (await asked(keeper)).includes(k1.src), "and the page asks its audio for that station's stream");

  // ----- pause, then a stranger comes to listen
  await keeper.click('#sr-play');
  expect(await untilKept('a pause', (v) => v.station_id === 'kexp' && v.playing === false), 'the play button pauses it for everyone and keeps the station');
  expect(await keeper.until('paused', `${text('.sr-by')} === 'paused by user' && ${text('.sr-live .label')} === 'idle'`), 'the keeper sees it paused');
  expect((await audio(keeper)).paused, 'and the audio stops');
  await keeper.shot('2-paused');

  const visitor = await open();
  if (!await visitor.until('the radio to draw for the stranger', `${text('.sr-station-name')} === 'KEXP Seattle'`)) return;
  await standIn(visitor);
  expect(await visitor.inFrame(`return document.getElementById('sr-station').disabled && document.getElementById('sr-play').disabled && document.getElementById('sr-station').value === 'kexp'`), 'a stranger sees the station and cannot touch the dial');
  expect(await visitor.inFrame(`return ${text('.sr-by')} === 'paused by user' && !document.getElementById('sr-voldn').disabled`), 'is told it is paused, and keeps their own volume');
  await visitor.shot('3-stranger-paused');

  // ----- play again, and the stranger's open page follows by itself
  await keeper.click('#sr-play');
  expect(await untilKept('playing again', (v) => v.station_id === 'kexp' && v.playing === true), 'play keeps it playing');
  expect(await visitor.until('the stranger to hear it', `${text('.sr-live .label')} === 'live' && ${text('.sr-by')} === 'playing by user'`), "the stranger's page is told, and goes live");
  expect((await asked(visitor)).includes('https://kexp-mp3-128.streamguys1.com/kexp128.mp3'), 'and asks its own audio for the same stream');

  // ----- a new station reaches the stranger too
  await choose(keeper, 'fip');
  expect(await untilKept('FIP', (v) => v.station_id === 'fip' && v.playing === true), 'a second station replaces the first');
  expect(await visitor.until('FIP for the stranger', `${text('.sr-station-name')} === 'FIP' && document.getElementById('sr-station').value === 'fip'`), 'the stranger follows it');
  expect((await audio(visitor)).src === 'https://icecast.radiofrance.fr/fip-midfi.mp3' && (await asked(visitor)).includes('https://icecast.radiofrance.fr/fip-midfi.mp3'), 'onto its stream');
  await visitor.shot('4-stranger-live');

  // ----- a station the worker does not know is refused, and the dial snaps back
  await keeper.inFrame(`const o = document.createElement('option'); o.value = 'pirate-radio'; o.textContent = 'Pirate'; document.getElementById('sr-station').append(o); return true;`);
  await choose(keeper, 'pirate-radio');
  expect(await keeper.until('the refusal', `${text('#sr-hint')} === 'unknown station' && document.getElementById('sr-station').value === 'fip'`), "the worker's own reason is shown and the dial goes back to FIP");
  expect((await kept())?.station_id === 'fip', 'and nothing was kept');

  // ----- the stranger's volume is their own
  await visitor.click('#sr-volup');
  await visitor.click('#sr-volup');
  expect(await visitor.inFrame(`return ${text('#sr-vol-readout')} === '25%'`) && Math.abs((await audio(visitor)).volume - 0.25) < 0.001, 'the stranger turns their own radio up');
  expect(await keeper.inFrame(`return ${text('#sr-vol-readout')} === '15%'`), "and the keeper's stays where it was");

  // ----- the keeper's volume and mute, kept in this browser
  await keeper.click('#sr-voldn');
  expect(await keeper.inFrame(`return ${text('#sr-vol-readout')} === '10%'`) && Math.abs((await audio(keeper)).volume - 0.1) < 0.001, 'volume down is five points');
  await keeper.click('#sr-mute');
  expect(await keeper.inFrame(`return ${text('#sr-vol-readout')} === 'muted' && document.getElementById('sr-volume').classList.contains('muted')`) && (await audio(keeper)).muted, 'mute silences this device');
  await sleep(900);
  const prefs = JSON.parse(await keeper.inFrame(`return await window.seamside.prefs.get('prefs');`) ?? 'null');
  expect(prefs?.volume === 10 && prefs?.muted === true, 'volume and mute are kept as this browser\'s own, under the key installed copies used');
  expect((await kept())?.station_id === 'fip' && (await kept())?.playing === true, 'and nothing of them reaches the shared state');
  await keeper.shot('5-muted');
  await keeper.click('#sr-mute');
  expect(await keeper.inFrame(`return ${text('#sr-vol-readout')} === '10%'`) && !(await audio(keeper)).muted, 'unmute brings the level back');
  await keeper.click('#sr-mute');
  await sleep(900);

  // ----- a browser that will not play before a gesture is offered one, without touching the room
  // Paused first, so the reloaded page plays nothing before its audio is stood in for.
  await keeper.click('#sr-play');
  await untilKept('a pause', (v) => v.playing === false);
  await keeper.send('Page.reload');
  keeper.child = null;
  for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
  if (!await keeper.until('the radio to come back', `${text('.sr-station-name')} === 'FIP' && ${text('.sr-by')} === 'paused by user'`)) return;
  if (!sandboxed) expect(await keeper.inFrame(`return ${text('#sr-vol-readout')} === 'muted'`), 'after a reload the keeper is still muted, at their own level');
  await standIn(keeper, true);
  await keeper.click('#sr-play');
  expect(await keeper.until('the enable-audio offer', `${text('#sr-hint .sr-hint-btn')} === 'click to enable audio on this device'`), 'a refused play offers a click to enable audio on this device');
  await keeper.shot('6-enable-audio');
  const before = await kept();
  await keeper.inFrame(`window.__refuse = false; return true;`);
  await keeper.click('#sr-hint .sr-hint-btn');
  expect(await keeper.until('the offer to go', `document.getElementById('sr-hint').hidden`), 'the click plays it here and the offer goes');
  const after = await kept();
  expect(after?.updated_at === before?.updated_at && after?.playing === true, 'and the shared state was not touched');

  // ----- clearing the station stops the radio for everyone
  await choose(keeper, '');
  expect(await untilKept('no station', (v) => v.station_id === null && v.playing === false), 'choosing no station clears it and stops');
  expect(await visitor.until('the stranger to stop', `${text('.sr-station-name')} === 'No station selected' && ${text('.sr-live .label')} === 'idle' && ${text('.sr-by')} === ''`), 'the stranger is told there is no station, and nothing asks them to pick one');
  expect((await audio(visitor)).src === '', "the stranger's audio lets go of the stream");
};
