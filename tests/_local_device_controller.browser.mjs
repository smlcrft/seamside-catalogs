// Local Device Controller in the viewer, where v1 has no device bus: the keeper and a
// stranger are each told that no device is connected, in their own words, and nothing more.

export default async ({ keeper, visitor: open, rows, expect }) => {
  const says = (re) => `${re}.test(document.getElementById('root')?.textContent ?? '')`;
  if (!await keeper.until('the page to draw', `!!document.querySelector('#root .fh-title')`)) return;
  expect(await keeper.until('the no-device note', says(/No device connected to this placement yet/)), 'the keeper is told no device is connected');
  expect(await keeper.inFrame(`return document.querySelector('#root .fh-title').textContent === 'local device'`), 'under the frame\'s own title');
  expect(await keeper.inFrame(`return !document.querySelector('#root .fh-gear, #root .grid, #root .err')`), 'with no settings, no controls and no error');
  expect(await keeper.inFrame(`return getComputedStyle(document.body).fontFamily !== '' && getComputedStyle(document.querySelector('.note')).fontSize !== getComputedStyle(document.body).fontSize`), 'the page has its style');
  await keeper.shot('1-keeper-no-device');

  const visitor = await open();
  if (!await visitor.until('the page to draw', `!!document.querySelector('#root .fh-title')`)) return;
  expect(await visitor.until('the no-device note', says(/The owner hasn't connected a device/)), "a stranger is told the owner hasn't connected one");
  expect(await visitor.inFrame(`return !document.querySelector('#root .fh-gear, #root .grid, #root .err')`), 'and offered nothing to press');
  await visitor.shot('2-visitor-no-device');

  expect((await rows('__fc_settings')).length === 0, 'opening the page writes no setting');
};
