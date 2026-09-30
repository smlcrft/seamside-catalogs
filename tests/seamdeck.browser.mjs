// Seamdeck in the viewer: the keeper opens a shot put lobby, a stranger at the
// published address joins it, the two take turns by holding O, and the board
// takes their initials.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  // a best already on the board: the page reads it through the worker
  await seed('_fdata/seamdeck_scores', 'old1', { initials: 'ANA', game_id: 'shotput', points: 10, scored_at: 5, client_id: 'c-ana', _created_at: 5, _modified_at: 5 });

  const text = `document.getElementById('root').textContent`;
  const hud = `document.querySelector('.hud .turn')?.textContent`;
  // O held for `ms`, by the pointer on the on-screen key, as a thumb would
  const hold = async (b, ms) => {
    const at = await b.inFrame(`const r = document.querySelector('.ab .key.A').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, b.child);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 }, b.child);
    await sleep(ms);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }, b.child);
  };
  // a throw is taken once the turn is this player's and every earlier throw has played out
  const turns = async () => (await keeper.inFrame(`return (await window.seamside.fetch('/api/state')).json().sessions[0]?.turns.length ?? 0`)) ?? 0;
  const toss = async (b, ms, what) => {
    if (!await b.until(`${what}: their turn`, `${hud} === 'YOUR TURN'`, 80)) return false;
    const before = await turns();
    for (let tries = 0; tries < 4; tries++) {
      await sleep(600);
      await hold(b, ms);
      for (let i = 0; i < 40; i++) { if (await turns() > before) return true; await sleep(250); }
    }
    return false;
  };

  if (!await keeper.until('the library to draw', `document.querySelectorAll('.library .cart').length === 5`)) return;
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.device')).display !== 'inline' && getComputedStyle(document.querySelector('.deck')).display !== 'inline'`), 'the console has its style');
  expect(await keeper.inFrame(`return ['Shot Put', 'Regatta', 'Hot Slice'].every((t) => [...document.querySelectorAll('.cart-title')].some((c) => c.textContent === t)) && document.querySelectorAll('.cart.soon').length === 2`), 'the library holds three games and two to come');
  await keeper.shot('1-library');

  await keeper.click('.cart:nth-child(1)');
  expect(await keeper.until('the lobby', `!!document.querySelector('.lobby') && document.querySelectorAll('.seat.filled').length === 1`), 'a game with no lobby opens one, the keeper seated as host');
  expect(await keeper.inFrame(`return document.querySelector('.lobby-foot .cta')?.textContent.trim() === 'Start' && !!document.querySelector('.seat.mine .seat-host')`), 'and the host is offered Start');

  const visitor = await open();
  if (!await visitor.until('the library for a stranger', `document.querySelectorAll('.library .cart').length === 5`)) return;
  expect(await visitor.until("the keeper's lobby on the cartridge", `document.querySelector('.cart:nth-child(1) .cart-live')?.textContent === 'lobby'`), "a stranger sees the keeper's lobby on the cartridge");
  await visitor.click('.cart:nth-child(1)');
  expect(await visitor.until('the join menu', `document.querySelectorAll('.jmenu .jopt').length === 2`), 'a game with a lobby asks which');
  expect(await visitor.inFrame(`return /lobby 1\\/6/.test(document.querySelector('.jopt').textContent) && /join/.test(document.querySelector('.jopt').textContent) && /Start new lobby/.test(document.querySelectorAll('.jopt')[1].textContent)`), "the keeper's lobby to join, or one of their own");
  await visitor.shot('2-join-menu');
  await visitor.click('.jopt:nth-child(2)');
  expect(await visitor.until('the lobby, seated', `document.querySelectorAll('.seat.filled').length === 2 && !!document.querySelector('.seat.mine')`), 'the stranger takes the second seat');
  expect(await visitor.inFrame(`return /waiting for host/.test(${text}) && !document.querySelector('.lobby-foot .cta')`), 'and waits for the host');
  expect(await keeper.until('the second seat to fill by itself', `document.querySelectorAll('.seat.filled').length === 2`), "the keeper's open page is told of it");
  await keeper.shot('3-lobby');

  await keeper.click('.lobby-foot .cta');
  expect(await keeper.until('the round', `!!document.querySelector('.playing .field')`), 'Start begins the round');
  expect(await visitor.until('the round for the stranger', `!!document.querySelector('.playing .field')`), 'for both of them');
  expect(await visitor.inFrame(`return /watching/.test(${hud})`), 'the stranger watches the host throw first');

  // landings at 14, 23 and 32 m: whatever the target, one of them scores
  for (const [n, ms] of [[1, 840], [2, 1380], [3, 1920]]) {
    expect(await toss(keeper, ms, 'the keeper'), `the keeper's throw ${n} is taken`);
    if (n === 1) await keeper.shot('4-throw');
    expect(await toss(visitor, ms, 'the stranger'), `the stranger's throw ${n} is taken`);
  }

  expect(await keeper.until('the results', `!!document.querySelector('.results') && document.querySelectorAll('.rank').length === 2`, 80), 'six throws end the round in results');
  expect(await visitor.until('the results for the stranger', `!!document.querySelector('.results')`, 80), 'for both of them');
  const placed = await untilRows('the scores', '_fdata/seamdeck_scores', (r) => r.filter((x) => x.cells.game_id === 'shotput' && x.cells.initials === '???').length === 2 && r);
  const mine = placed?.find((x) => x.cells.initials === '???' && x.cells.points > 0);
  expect(mine && mine.cells.client_id && mine.cells.scored_at > 0 && mine.cells._created_at && mine.cells._modified_at, "each player's best is a row of the space, waiting for initials");
  expect(await keeper.inFrame(`return !!document.querySelector('.initials-input') && /ENTER INITIALS/.test(${text})`), 'the keeper is asked for initials');
  expect(await keeper.inFrame(`return [...document.querySelectorAll('.lb-row .lb-init')].some((e) => e.textContent === 'ANA')`), 'the board holds the best already on it');
  await keeper.shot('5-results');

  await keeper.fill('.initials-input', 'kee');
  await keeper.press('Enter');
  expect(await untilRows('the initials', '_fdata/seamdeck_scores', (r) => r.find((x) => x.cells.initials === 'KEE' && x.cells.game_id === 'shotput')), "the keeper's score takes their initials");
  expect(await keeper.until('the board to show them', `[...document.querySelectorAll('.lb-row .lb-init')].some((e) => e.textContent === 'KEE') && !document.querySelector('.initials-input')`), 'and the board and the ranking show them');
  expect(await visitor.until("the keeper's initials to reach the stranger", `[...document.querySelectorAll('.rank-name')].some((e) => e.textContent === 'KEE')`), "the stranger's page is told to read again");
  await visitor.fill('.initials-input', 'VIS');
  await visitor.click('.initials button');
  const both = await untilRows("the stranger's initials", '_fdata/seamdeck_scores', (r) => r.find((x) => x.cells.initials === 'VIS'));
  expect(both?.cells.game_id === 'shotput' && both?.cells.points > 0, "the stranger's score takes theirs");
  expect((await rows('_fdata/seamdeck_scores')).every((x) => x.cells.initials !== '???'), 'no score is left waiting');
  expect(await visitor.until('both on the board', `['KEE', 'VIS', 'ANA'].every((i) => [...document.querySelectorAll('.lb-row .lb-init')].some((e) => e.textContent === i))`), 'the stranger sees every initials on the board');
  expect(await visitor.inFrame(`return !document.querySelector('.results-actions .cta')`), 'and has no Play again, not being the host');
  await visitor.shot('6-board');

  await keeper.click('.results-actions .cta');
  expect(await keeper.until('the lobby again', `!!document.querySelector('.lobby') && document.querySelectorAll('.seat.filled').length === 2`), 'Play again goes back to the lobby, seats kept');
  expect(await visitor.until('the lobby again for the stranger', `!!document.querySelector('.lobby')`), 'for both of them');
  await keeper.click('.deck .home');
  expect(await keeper.until('the library', `!!document.querySelector('.library')`), 'the library button leaves the lobby');
  expect(await visitor.until('the stranger to be host', `document.querySelectorAll('.seat.filled').length === 1 && document.querySelector('.lobby-foot .cta')?.textContent.trim() === 'Start'`), 'the stranger is left host of the lobby');
  await visitor.shot('7-host');
};
