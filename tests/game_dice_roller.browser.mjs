// Dice Roller in the viewer: the keeper rolls, and a stranger at the published address
// watches the same die tumble and land.

export default async ({ keeper, visitor: open, expect, sleep }) => {
  const face = `document.querySelector('#die').textContent`;
  const said = `document.querySelector('#result').textContent`;
  const landed = (b) => b.inFrame(`return { face: ${face}, said: ${said} };`);

  if (!await keeper.until('the die to draw', `${face} === '?' && ${said} === 'tap to roll'`)) return;
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('#roll-btn')).display !== 'none' && getComputedStyle(document.querySelector('#die')).cursor === 'pointer'`), 'the keeper may roll: the die and roll again are offered');
  expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('#die')).display === 'flex'`), 'the page has its style');
  await keeper.shot('1-unrolled');

  const visitor = await open();
  if (!await visitor.until('the die for a stranger', `${face} === '?' && ${said} === 'watching the dice'`)) return;
  expect(await visitor.inFrame(`return getComputedStyle(document.querySelector('#roll-btn')).display === 'none' && getComputedStyle(document.querySelector('#die')).cursor === 'default'`), 'a stranger only watches: no roll again, no pointer');
  await visitor.shot('2-watching');

  // a tap on the die rolls it, for everyone watching
  await keeper.click('#die');
  expect(await keeper.until('the tumble', `document.querySelector('#die').classList.contains('rolling')`, 8), "the keeper's die tumbles");
  expect(await visitor.until('the stranger to see it tumble', `document.querySelector('#die').classList.contains('rolling')`, 12), "and the stranger's open page is told of the roll");
  expect(await keeper.until('it to land', `/^rolled [1-6]$/.test(${said}) && !document.querySelector('#die').classList.contains('rolling')`, 20), 'the die lands on a number');
  expect(await visitor.until('it to land for the stranger', `/^rolled [1-6]$/.test(${said}) && !document.querySelector('#die').classList.contains('rolling')`, 20), 'and lands for the stranger too');
  const first = await landed(keeper);
  const seen = await landed(visitor);
  expect(first.face === seen.face && first.said === seen.said && '⚀⚁⚂⚃⚄⚅'.includes(first.face), `both land on the same face (${first.face}, ${first.said})`);
  await keeper.shot('3-rolled');
  await visitor.shot('4-rolled-watching');

  // a stranger's tap rolls nothing
  await visitor.click('#die');
  await sleep(1500);
  expect(!await visitor.inFrame(`return document.querySelector('#die').classList.contains('rolling')`) && !await keeper.inFrame(`return document.querySelector('#die').classList.contains('rolling')`), "a stranger's tap rolls nothing");

  // roll again, by the button, until a roll lands on a different face: each one tumbles for both
  let again = first;
  for (let i = 0; i < 8 && again.face === first.face; i++) {
    await keeper.click('#roll-btn');
    expect(await visitor.until('the stranger to see the next roll', `document.querySelector('#die').classList.contains('rolling')`, 12), `roll again tumbles for the stranger (${i + 1})`);
    await keeper.until('the next roll to land', `!document.querySelector('#die').classList.contains('rolling')`, 20);
    await visitor.until('and for the stranger', `!document.querySelector('#die').classList.contains('rolling')`, 20);
    again = await landed(keeper);
    const theirs = await landed(visitor);
    expect(theirs.face === again.face, `and lands on the same face for both (${again.face})`);
  }
  expect(again.face !== first.face, 'a later roll can land elsewhere');

  // a stranger who comes back sees where the die lies, without a tumble
  await visitor.send('Page.reload');
  visitor.child = null;
  for (let i = 0; i < 60 && !visitor.child; i++) await sleep(250);
  expect(await visitor.until('the die again', `${face} === ${JSON.stringify(again.face)} && ${said} === ${JSON.stringify(again.said)} && !document.querySelector('#die').classList.contains('rolling')`), 'a stranger who comes back sees the last roll, still');
  await visitor.shot('5-back');
};
