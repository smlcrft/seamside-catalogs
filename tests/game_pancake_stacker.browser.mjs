// Pancake Stacker in the viewer: the keeper stacks a new best, which a stranger's open page
// is told of; the stranger plays a game of their own, which is not recorded.

export default async ({ keeper, visitor: open, rows, untilRows, seed, expect, sleep }) => {
  // Where the moving pancake and the top of the stack lie, read off the canvas: it is cleared
  // to transparent each frame, so a pancake is its opaque pixels.
  const look = (b) => b.inFrame(`
    const c = document.getElementById('game'), g = c.getContext('2d');
    const span = (y) => { const d = g.getImageData(0, y, c.width, 1).data; let l = -1, r = -1;
      for (let x = 0; x < c.width; x++) if (d[x * 4 + 3] > 200) { if (l < 0) l = x; r = x; } return l < 0 ? null : [l, r]; };
    let top = null;
    for (let y = 64; y < c.height - 11 && !top; y++) if (span(y)) top = span(y + 11);
    return { moving: span(41), top, score: +document.getElementById('score').textContent, over: !!document.getElementById('modal') };`);
  const drop = (b) => b.press('Space');

  // Drop when the moving pancake's left edge is `offset` from the stack's, or as near as its
  // swing reaches: a pancake swings between the griddle's edges.
  async function dropAt(b, offset, seconds = 20) {
    const end = Date.now() + seconds * 1000;
    const before = (await look(b)).score;
    while (Date.now() < end) {
      const s = await look(b);
      if (!s.moving || !s.top) continue;
      const lo = -s.top[0] + 8, hi = 359 - (s.moving[1] - s.moving[0]) - s.top[0] - 8;
      if (Math.abs(s.moving[0] - s.top[0] - Math.min(hi, Math.max(lo, offset))) <= 3) {
        await drop(b);
        for (let i = 0; i < 40; i++) { const t = await look(b); if (t.score !== before || t.over) return t; await sleep(50); }
        return look(b);
      }
    }
    return null;
  }

  // a best already in the table
  await seed('_fdata/pancake_scores', 'old_player', { name: 'Ana', score: 2, at: 5, _created_at: 5, _modified_at: 5 });
  await keeper.send('Page.reload');
  keeper.child = null;
  for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
  if (!await keeper.until('the griddle', `!!document.getElementById('startBtn') && document.getElementById('best').textContent === '2'`)) return;
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.board')).display === 'flex' && /Ready the griddle/.test(document.querySelector('.board').textContent)`), "the page has its style, and the best already there is shown");
  await keeper.shot('1-start');

  const visitor = await open();
  if (!await visitor.until('the griddle for a stranger', `!!document.getElementById('startBtn') && document.getElementById('best').textContent === '2'`)) return;
  expect(true, "a stranger sees the space's best");

  await keeper.click('#startBtn');
  expect(await keeper.until('the game to start', `!document.getElementById('start')`), 'Start stacking begins the game');
  let s = await dropAt(keeper, 0);
  expect(s?.score === 1 && !s.over, 'a pancake dropped over the stack lands');
  await keeper.shot('2-stacking');
  s = await dropAt(keeper, 1000);
  const wide = s?.top ? s.top[1] - s.top[0] : 0;
  expect(s?.score === 2 && !s.over && wide < 90, `one landed off to the side is trimmed to the overlap (${wide} px)`);
  s = await dropAt(keeper, wide - 12);
  const width = s?.top ? s.top[1] - s.top[0] : 0;
  expect(s?.score === 3 && !s.over && width > 0 && width < 30, `and again, so the tower narrows (${width} px)`);
  s = await dropAt(keeper, s?.top && s.top[0] > 180 ? -1000 : 1000);
  expect(s?.over && s.score === 3, 'a pancake that misses the stack topples it');
  if (!await keeper.until('the result', `!!document.getElementById('again')`)) return;
  expect(await keeper.until('the new best', `/New best!/.test(document.getElementById('modal').textContent) && /You stacked 3 pancakes\\./.test(document.getElementById('modal').textContent)`), 'the keeper is told it is a new best');
  expect(await keeper.until('the best to follow', `document.getElementById('best').textContent === '3'`), 'and the HUD follows the answer');
  expect(await keeper.until('the holder', `document.querySelector('#modal .holder')?.textContent === 'best held by the owner'`), 'the best is held by the owner');
  const mine = await untilRows('the score', '_fdata/pancake_scores', (r) => r.find((x) => x.id !== 'old_player' && x.cells.score === 3));
  expect(mine?.id.startsWith('did_dht_') && mine?.cells.name === 'the owner' && mine?.cells.at > 0 && mine?.cells._created_at && mine?.cells._modified_at, "the game is the keeper's row, in the table's shape");
  expect((await rows('_fdata/pancake_scores')).find((x) => x.id === 'old_player')?.cells.score === 2, 'the best already there is kept as it was');
  await keeper.shot('3-new-best');

  // nobody touches the stranger's page: the push says to read again
  expect(await visitor.until('the new best to reach the stranger', `document.getElementById('best').textContent === '3'`), "the stranger's open page is told of the new best");

  // the stranger plays a game of their own, which is not recorded
  await visitor.click('#startBtn');
  expect(await visitor.until('their game to start', `!document.getElementById('start')`), 'a stranger stacks too');
  await drop(visitor);
  expect(await visitor.until('the first to land', `document.getElementById('score').textContent === '1'`), 'their first pancake lands');
  s = await dropAt(visitor, (await look(visitor)).top?.[0] > 180 ? -1000 : 1000);
  expect(s?.over, 'and a miss topples their stack');
  expect(await visitor.until('their result', `/Stack toppled\\./.test(document.getElementById('modal')?.textContent ?? '') && document.querySelector('#modal .holder')?.textContent === 'best held by the owner'`), 'they are told, and who holds the best');
  await visitor.shot('4-stranger');
  await sleep(500);
  expect((await rows('_fdata/pancake_scores')).length === 2, "a stranger's game is not recorded");

  // play again
  await keeper.click('#again');
  expect(await keeper.until('a fresh stack', `!document.getElementById('modal') && document.getElementById('score').textContent === '0'`), 'Play again starts a fresh stack');
  s = await dropAt(keeper, 0);
  expect(s?.score === 1, 'and it stacks');
};
