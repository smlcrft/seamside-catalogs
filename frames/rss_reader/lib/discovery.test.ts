import assert from "node:assert/strict";
import { looksLikeFeed, discoverFeedUrl } from "./discovery.ts";

Deno.test("looksLikeFeed detects rss/atom", () => {
  assert.equal(looksLikeFeed(`<?xml version="1.0"?><rss><channel></channel></rss>`), true);
  assert.equal(looksLikeFeed(`<feed xmlns="http://www.w3.org/2005/Atom"></feed>`), true);
  assert.equal(looksLikeFeed(`<!doctype html><html><body>hi</body></html>`), false);
});

Deno.test("discoverFeedUrl finds and absolutizes href", () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    </head></html>`;
  assert.equal(discoverFeedUrl(html, "https://blog.ex.com/posts"), "https://blog.ex.com/feed.xml");
});

Deno.test("discoverFeedUrl returns null when none", () => {
  assert.equal(discoverFeedUrl(`<html><head></head></html>`, "https://ex.com"), null);
});

Deno.test("discoverFeedUrl scans past a non-feed alternate to the real feed", () => {
  const html = `<head>
    <link rel="alternate" hreflang="es" href="/es">
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
  </head>`;
  assert.equal(discoverFeedUrl(html, "https://ex.com/"), "https://ex.com/atom.xml");
});
