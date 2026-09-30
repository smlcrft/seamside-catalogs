// ASCII Runner in the viewer: the keeper plays a run to its end and keeps the high score on
// this device; a stranger at the published address plays too.

const SANDBOX = !!process.env.CATALOG_CHECK_SANDBOX;

export default async ({ keeper, visitor: open, expect, sleep }) => {
  const text = (sel) => `(document.querySelector('${sel}')?.textContent ?? '')`;
  const hidden = (sel) => `document.querySelector('${sel}').classList.contains('hidden')`;

  // Jump the next rock as it comes, by the up arrow, until the score reaches `target`.
  async function jumpRocks(b, target, seconds = 40) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const s = await b.inFrame(`
        const xs = [...document.querySelectorAll('#obstacle-layer .obstacle')].map((o) => 700 - parseFloat(o.style.right));
        return { score: +document.querySelector('#score').textContent, over: !document.querySelector('#game-over').classList.contains('hidden'),
                 near: xs.some((x) => x > 88 && x < 125), jumping: document.querySelector('#player').classList.contains('jumping') };`);
      if (s.score >= target || s.over) return s;
      if (s.near && !s.jumping) await b.press('ArrowUp');
      else await sleep(15);
    }
    return null;
  }

  if (!await keeper.until('the start screen', `!!document.querySelector('#start-btn') && !${hidden('#start-screen')}`)) return;
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('#game-area')).position !== 'static' && document.styleSheets.length >= 2`), 'the page has its style');
  expect(await keeper.inFrame(`return ${text('#high-score-start')} === ''`), 'a first visit shows no high score');
  await keeper.shot('1-start');

  await keeper.click('#start-btn');
  expect(await keeper.until('the run to start', `${hidden('#start-screen')} && ${text('#health')} === '♥♥♥'`), 'Start begins a run with three lives');
  expect(await keeper.until('a rock to come', `document.querySelectorAll('#obstacle-layer .obstacle').length > 0`), 'rocks come along');

  // hold the down arrow: the runner ducks, and stands again when it is let go
  await keeper.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, keeper.child);
  expect(await keeper.until('the duck', `document.querySelector('#player').classList.contains('ducking') && ${text('#player .player-sprite')} === '_o_'`, 20), 'the down arrow ducks');
  await keeper.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, keeper.child);
  expect(await keeper.until('standing again', `!document.querySelector('#player').classList.contains('ducking')`, 20), 'and letting go stands up');

  const ran = await jumpRocks(keeper, 30);
  expect(ran && ran.score >= 30, `the up arrow jumps rocks, and each one cleared scores (score ${ran?.score})`);
  await keeper.shot('2-running');

  // stop jumping: three hits and the run is over
  expect(await keeper.until('a hit', `${text('#health')} !== '♥♥♥'`, 60), 'a rock not jumped costs a life');
  if (!await keeper.until('the game to end', `!${hidden('#game-over')}`, 120)) return;
  const score = await keeper.inFrame(`return +document.querySelector('#score').textContent;`);
  expect(await keeper.inFrame(`return ${text('#health')} === '♡♡♡' && ${text('#final-score')} === 'Final Score: ${score}'`), `three hits end the run at ${score}`);
  expect(await keeper.inFrame(`return ${text('#high-score-display')} === '🏆 NEW HIGH SCORE: ${score}!'`), 'a first run is a new high score');
  expect(await keeper.inFrame(`return localStorage.getItem('prefs/asciiRunnerHighScore') === '${score}' || ${SANDBOX}`), "kept in this device's own prefs");
  await keeper.shot('3-game-over');

  // play again, and end straight away: the old high score stands
  await keeper.click('#restart-btn');
  expect(await keeper.until('a second run', `${hidden('#game-over')} && ${text('#score')} === '0' && ${text('#health')} === '♥♥♥'`), 'Play again starts over');
  if (!await keeper.until('the second run to end', `!${hidden('#game-over')}`, 160)) return;
  expect(await keeper.inFrame(`return ${text('#high-score-display')} === 'High Score: ${score}'`), 'a lower run leaves the high score as it was');

  // the high score is this device's: back at the start screen after a reload
  await keeper.send('Page.reload');
  keeper.child = null;
  for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
  if (!await keeper.until('the start screen again', `!!document.querySelector('#start-btn')`)) return;
  if (SANDBOX) {
    // a sandboxed page's prefs last one document
    expect(await keeper.until('the page to settle', `${text('#high-score-start')} === ''`), 'in the sandbox the high score lasted the one document');
  } else {
    expect(await keeper.until('the high score back', `${text('#high-score-start')} === 'High Score: ${score}'`), 'a keeper who comes back sees their high score');
  }
  await keeper.shot('4-back');

  // a stranger plays their own game, at the published address
  const visitor = await open();
  if (!await visitor.until('the start screen for a stranger', `!!document.querySelector('#start-btn') && !${hidden('#start-screen')}`)) return;
  expect(await visitor.inFrame(`return ${text('#high-score-start')} === ''`), "a stranger's page shows none of the keeper's high score");
  await visitor.click('#start-btn');
  expect(await visitor.until('their run to start', `${hidden('#start-screen')} && document.querySelectorAll('#obstacle-layer .obstacle').length > 0`), 'a stranger plays');
  const theirs = await jumpRocks(visitor, 10);
  expect(theirs && theirs.score >= 10, "and the stranger's up arrow jumps too");
  await visitor.shot('5-stranger');
};
