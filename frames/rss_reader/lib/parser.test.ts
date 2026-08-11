import assert from "node:assert/strict";
import { parseFeed } from "./parser.ts";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Example Blog</title>
  <item><title><![CDATA[Hello & Goodbye]]></title><link>https://ex.com/a</link>
    <guid>tag:ex,1</guid><pubDate>Tue, 10 Jun 2025 09:00:00 GMT</pubDate>
    <description>&lt;p&gt;body one&lt;/p&gt;</description></item>
  <item><title>No Guid Post</title><link>https://ex.com/b</link>
    <content:encoded><![CDATA[<p>rich</p>]]></content:encoded></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <entry><title>Atom One</title><link href="https://ex.com/atom1" rel="alternate"/>
    <id>urn:1</id><updated>2025-06-10T09:00:00Z</updated>
    <author><name>Jane</name></author><content type="html">&lt;p&gt;atom body&lt;/p&gt;</content></entry>
</feed>`;

Deno.test("parseFeed reads RSS title + items", () => {
  const f = parseFeed(RSS, "https://ex.com/feed.xml");
  assert.equal(f.title, "Example Blog");
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].title, "Hello & Goodbye");
  assert.equal(f.items[0].link, "https://ex.com/a");
  assert.equal(f.items[0].guid, "tag:ex,1");
  assert.equal(typeof f.items[0].published_at, "number");
  assert.match(f.items[0].content, /body one/);
});

Deno.test("parseFeed falls back guid->link and reads content:encoded", () => {
  const f = parseFeed(RSS, "https://ex.com/feed.xml");
  assert.equal(f.items[1].guid, "https://ex.com/b");
  assert.match(f.items[1].content, /rich/);
});

Deno.test("parseFeed reads Atom entries with href link + author", () => {
  const f = parseFeed(ATOM, "https://ex.com/feed.xml");
  assert.equal(f.title, "Atom Example");
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].link, "https://ex.com/atom1");
  assert.equal(f.items[0].guid, "urn:1");
  assert.equal(f.items[0].author, "Jane");
  assert.match(f.items[0].content, /atom body/);
});

Deno.test("parseFeed RSS item falls back to atom:link href", () => {
  const rss = `<rss version="2.0"><channel><title>X</title>
    <item><title>T</title><atom:link rel="alternate" href="https://ex.com/z"/><guid>g1</guid></item>
  </channel></rss>`;
  const f = parseFeed(rss, "https://ex.com/feed.xml");
  assert.equal(f.items[0].link, "https://ex.com/z");
});
