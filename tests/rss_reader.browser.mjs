// RSS Reader in the viewer: the keeper subscribes to a site served here on loopback
// (so nothing leaves this machine), reads, boosts and discusses; a stranger is told the
// room is for members.

import { createServer } from 'node:http';

export default async ({ keeper, visitor: open, rows, untilRows, expect, sleep }) => {
  // A site that names its feed, and the feed, which grows when told to.
  const entries = [
    { guid: 'post-1', title: 'First post', body: '<p>Hello <b>readers</b>.</p><img src="http://127.0.0.1:1/pic.png" alt="a cat">', date: 'Mon, 01 Sep 2026 10:00:00 GMT' },
    { guid: 'post-2', title: 'Second post', body: '<p>Something about gardens.</p>', date: 'Tue, 02 Sep 2026 10:00:00 GMT' },
  ];
  const feed = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Loopback Log</title>${entries.map((e) =>
    `<item><title>${e.title}</title><guid>${e.guid}</guid><link>https://example.com/${e.guid}</link><pubDate>${e.date}</pubDate><description><![CDATA[${e.body}]]></description></item>`).join('')}</channel></rss>`;
  const server = createServer((req, res) => {
    if (req.url === '/feed.xml') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(feed()); return; }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>a blog</body></html>'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const site = `http://127.0.0.1:${server.address().port}`;
  const root = `document.body`;

  // The window is 900 wide, where the frame draws one pane at a time: widen it for the
  // three-pane reader, and narrow it again at the end for the drawer.
  const wide = (width) => keeper.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });

  try {
    await wide(1400);
    if (!await keeper.until('the reader to draw', `!!document.querySelector('.sidebar .brand')`)) return;
    expect(await keeper.until('an empty list', `/No items here yet\\./.test(${root}.textContent)`), 'the keeper has the reader, empty');
    expect(await keeper.inFrame(`return getComputedStyle(document.querySelector('.app')).display === 'grid' && !!document.querySelector('.iconbtn[title="Add feed"]') && !!document.querySelector('.iconbtn[title="Refresh (r)"]')`), 'the page has its style, and an editor has Add feed and Refresh');
    await keeper.shot('1-empty');

    // a site's address, and the frame finds its feed
    await keeper.click('.iconbtn[title="Add feed"]');
    await keeper.until('the prompt', `!!document.querySelector('.framelib-dialog-host .framelib-prompt-input')`);
    await keeper.fill('.framelib-dialog-host .framelib-prompt-input', `${site}/`);
    await keeper.press('Enter');
    const added = await untilRows('the feed', 'rss_feeds', (r) => r.find((x) => x.cells.url === `${site}/feed.xml` && x.cells.last_fetched));
    expect(added?.cells.site_url === `${site}/` && added?.cells.title === 'Loopback Log' && added?.cells.last_error === null && added?.cells.last_fetched > 0 && added?.cells._created_at && added?.cells.added_by, 'a site pasted is followed through to its feed, a row of the space');
    const items = await untilRows('its items', 'rss_items', (r) => r.length === 2 && r);
    expect(items && items.every((i) => i.cells.feed_id === added?.id && i.cells.fetched_at > 0 && /^[0-9a-f]{32}$/.test(i.id)), 'its items are rows of the space, named for the feed and the guid');
    expect(await keeper.until('the items to draw', `[...document.querySelectorAll('.item .it-title')].map((t) => t.textContent).join('|') === 'Second post|First post'`), 'and drawn newest first');
    expect(await keeper.inFrame(`return [...document.querySelectorAll('.sidebar .navrow')].some((r) => /Loopback Log/.test(r.textContent) && /2/.test(r.querySelector('.n').textContent))`), 'the feed is listed with two unread');
    await keeper.shot('2-feed');

    // a refused address is said in the frame's words
    await keeper.click('.iconbtn[title="Add feed"]');
    await keeper.until('the prompt', `!!document.querySelector('.framelib-dialog-host .framelib-prompt-input')`);
    await keeper.fill('.framelib-dialog-host .framelib-prompt-input', 'ftp://example.com/feed');
    await keeper.click('.framelib-dialog-host .framelib-btn-primary');
    expect(await keeper.until('the refusal', `/only http and https addresses can be fetched/.test(document.querySelector('.framelib-dialog-host')?.textContent ?? '')`), 'an address that is not the web is refused, and says why');
    await keeper.shot('3-refused');
    await keeper.click('.framelib-dialog-host .framelib-btn-primary');
    await sleep(300);
    expect((await rows('rss_feeds')).length === 1, 'and nothing is added');

    // reading: an item opens and is marked read
    await keeper.inFrame(`[...document.querySelectorAll('.item')].find((i) => /First post/.test(i.textContent)).setAttribute('data-pick', '1'); return true;`);
    await keeper.click('.item[data-pick]');
    expect(await keeper.until('the reader pane', `document.querySelector('.reader h1')?.textContent === 'First post'`), 'the item opens beside the list');
    const first = items?.find((i) => i.cells.guid === 'post-1');
    expect(await untilRows('the read mark', 'rss_reads', (r) => r.find((x) => x.cells.item_id === first?.id && x.cells.read_at > 0)), 'opening it marks it read, a row of the space');
    expect(await keeper.inFrame(`return /Hello readers\\./.test(document.querySelector('.reader .content').textContent) && !document.querySelector('.reader .content img') && /picture: a cat/.test(document.querySelector('.reader .content .imglink')?.textContent ?? '')`), 'its words are shown, and its outside picture is a link, never loaded');
    expect(await keeper.until('the count to follow', `[...document.querySelectorAll('.sidebar .navrow')].find((r) => /Loopback Log/.test(r.textContent))?.querySelector('.n').textContent === '1'`), 'and the feed counts one unread');

    // boost, comment, reply, delete
    await keeper.click('.reader .boostbtn');
    expect(await untilRows('the boost', 'rss_boosts', (r) => r.find((x) => x.cells.item_id === first?.id && x.cells.user_id && x.cells.created_at > 0)), 'a boost is a row of the space');
    expect(await keeper.until('the boost to draw', `document.querySelector('.reader .boostbtn.on')?.textContent.trim() === '↑ 1' && /boosted by/.test(document.querySelector('.reader').textContent)`), 'and the button says so');
    await keeper.fill('.cmt-form input', 'Worth a read.');
    await keeper.press('Enter');
    const said = await untilRows('the comment', 'rss_comments', (r) => r.find((x) => x.cells.body === 'Worth a read.'));
    expect(said?.cells.item_id === first?.id && said?.cells.parent_id === null && said?.cells._created_at, 'Enter posts a comment, a row of the space');
    expect(await keeper.until('the comment to draw', `document.querySelector('.cmt .body')?.textContent === 'Worth a read.' && document.querySelector('.cmt-form input').value === ''`), 'drawn, and the field emptied');
    await keeper.click('.cmt .acts button');
    expect(await keeper.until('the reply field', `document.querySelector('.cmt-form input').placeholder === 'Reply…'`), 'Reply turns the field to a reply');
    await keeper.fill('.cmt-form input', 'Agreed.');
    await keeper.press('Enter');
    expect(await untilRows('the reply', 'rss_comments', (r) => r.find((x) => x.cells.body === 'Agreed.' && x.cells.parent_id === said?.id)), 'a reply is kept under its comment');
    expect(await keeper.until('the reply to draw', `document.querySelector('.cmt-children .cmt .body')?.textContent === 'Agreed.'`), 'and drawn nested');
    await keeper.shot('4-discussion');
    await keeper.inFrame(`[...document.querySelectorAll('.cmt .acts button')].find((b) => b.textContent === 'Delete').setAttribute('data-del', '1'); return true;`);
    await keeper.click('[data-del]');
    await keeper.until('the question', `!!document.querySelector('.framelib-dialog-host .framelib-btn-danger')`);
    await keeper.click('.framelib-dialog-host .framelib-btn-danger');
    expect(await untilRows('the thread to go', 'rss_comments', (r) => r.length === 0 || null), 'deleting a comment takes its reply with it');
    expect(await keeper.until('the thread to clear', `!document.querySelector('.cmt')`), 'and the page follows');

    // a group
    await keeper.click('.iconbtn[title="Add group"]');
    await keeper.until('the prompt', `!!document.querySelector('.framelib-dialog-host .framelib-prompt-input')`);
    await keeper.fill('.framelib-dialog-host .framelib-prompt-input', 'Blogs');
    await keeper.press('Enter');
    expect(await untilRows('the group', 'rss_groups', (r) => r.find((x) => x.cells.name === 'Blogs' && x.cells.sort === 0)), 'a group is a row of the space');
    expect(await keeper.until('the group to list', `[...document.querySelectorAll('.sidebar .label span')].some((s) => s.textContent === 'Blogs')`), 'and listed');

    // keys: j opens the next item and marks it, b boosts it (and reads the list again), m marks it unread
    await keeper.inFrame(`document.activeElement?.blur?.(); return true;`);
    await keeper.press('Escape');
    await keeper.press('j');
    const second = items?.find((i) => i.cells.guid === 'post-2');
    expect(await keeper.until('j to open an item', `document.querySelector('.reader h1')?.textContent === 'Second post'`), 'j opens the first item in the list');
    expect(await untilRows('its read mark', 'rss_reads', (r) => r.find((x) => x.cells.item_id === second?.id)), 'and marks it read');
    await keeper.press('b');
    expect(await untilRows('the boost', 'rss_boosts', (r) => r.find((x) => x.cells.item_id === second?.id)), 'b boosts it');
    expect(await keeper.until('the list to read again', `document.querySelector('.item.sel')?.classList.contains('read')`), 'and the list shows it read');
    await keeper.press('m');
    expect(await untilRows('the mark to go', 'rss_reads', (r) => !r.some((x) => x.cells.item_id === second?.id)), 'm marks it unread again');

    // search
    await keeper.fill('.search', 'gardens');
    expect(await keeper.until('the list to narrow', `[...document.querySelectorAll('.item .it-title')].map((t) => t.textContent).join('|') === 'Second post'`), 'search narrows the list to what says it');
    await keeper.clear('.search');
    expect(await keeper.until('the list to come back', `document.querySelectorAll('.item').length === 2`), 'and an empty search shows all again');

    // refresh brings what the site added, and never an item twice
    entries.push({ guid: 'post-3', title: 'Third post', body: '<p>New today.</p>', date: 'Wed, 03 Sep 2026 10:00:00 GMT' });
    await keeper.click('.iconbtn[title="Refresh (r)"]');
    const third = await untilRows('the new item', 'rss_items', (r) => r.length === 3 && r.find((x) => x.cells.guid === 'post-3'));
    expect(third && (await rows('rss_items')).filter((x) => x.cells.guid === 'post-1').length === 1, 'Refresh brings the new item and not the old ones again');
    expect(await keeper.until('the new item to draw', `document.querySelector('.item .it-title')?.textContent === 'Third post'`), 'and it is drawn first');
    await keeper.shot('5-refreshed');

    // a stranger at the published address
    const visitor = await open();
    expect(await visitor.until('the members note', `/This reader is shared with this space's members\\./.test(document.body.textContent)`), 'a stranger is told the reader is for members');
    expect(await visitor.inFrame(`return !document.querySelector('.item') && !/Loopback Log|First post/.test(document.body.textContent)`), 'and is shown no feed and no item');
    await visitor.shot('6-stranger');

    // narrow: the sidebar is a drawer, and an item is a page of its own with a way back
    await wide(700);
    if (await keeper.until('the item alone', `!!document.querySelector('.reader .backbtn')`)) await keeper.click('.reader .backbtn');
    expect(await keeper.until('the narrow layout', `!!document.querySelector('.app.mobile') && !!document.querySelector('.toolbar .iconbtn[title="Menu"]')`), 'a narrow page draws one pane, with a menu');
    await keeper.click('.toolbar .iconbtn[title="Menu"]');
    expect(await keeper.until('the drawer', `!!document.querySelector('.sidebar.open') && !!document.querySelector('.drawer-backdrop')`), 'the menu opens the drawer');
    await keeper.shot('7-drawer');
    await keeper.inFrame(`[...document.querySelectorAll('.sidebar .navrow')].find((r) => /Unread/.test(r.textContent)).setAttribute('data-go', '1'); return true;`);
    await keeper.click('.sidebar [data-go]');
    expect(await keeper.until('the unread view', `!document.querySelector('.sidebar.open') && /Unread/i.test(document.querySelector('.toolbar strong').textContent) && [...document.querySelectorAll('.item .it-title')].every((t) => t.textContent !== 'First post')`), 'choosing a view closes the drawer and shows what is unread');
    await keeper.click('.item');
    expect(await keeper.until('the item alone', `!!document.querySelector('.reader .backbtn') && !document.querySelector('.list')`), 'an item opens on its own, with Back');
    await keeper.click('.reader .backbtn');
    expect(await keeper.until('the list again', `!!document.querySelector('.list') && !document.querySelector('.reader')`), 'and Back returns to the list');
    await wide(1400);

    // what was fetched is the space's, not the page's
    await keeper.send('Page.reload');
    keeper.child = null;
    for (let i = 0; i < 60 && !keeper.child; i++) await sleep(250);
    expect(await keeper.until('the reader again', `document.querySelectorAll('.item').length === 3`), 'a keeper who comes back finds the three items');
  } finally {
    server.close();
  }
};
