import assert from "node:assert/strict";
import { sanitizeHtml } from "./sanitize.ts";

Deno.test("strips script and style blocks", () => {
  const out = sanitizeHtml(`<p>ok</p><script>alert(1)</script><style>*{}</style>`);
  assert.equal(out.includes("<script"), false);
  assert.equal(out.includes("<style"), false);
  assert.match(out, /<p>ok<\/p>/);
});

Deno.test("strips event handlers and javascript: urls", () => {
  const out = sanitizeHtml(`<a href="javascript:alert(1)" onclick="x()">hi</a>`);
  assert.equal(/onclick/i.test(out), false);
  assert.equal(/javascript:/i.test(out), false);
  assert.match(out, />hi<\/a>/);
});

Deno.test("keeps safe links and images", () => {
  const out = sanitizeHtml(`<a href="https://ex.com">x</a><img src="https://ex.com/i.png">`);
  assert.match(out, /href="https:\/\/ex\.com"/);
  assert.match(out, /src="https:\/\/ex\.com\/i\.png"/);
});

Deno.test("defeats nested-decoy script reconstruction (fixpoint)", () => {
  const evil = "<scr<style></style>ipt>alert(1)</scr<style>foo</style>ipt>";
  const out = sanitizeHtml(evil);
  assert.equal(/<script/i.test(out), false);
});

Deno.test("blocks entity/whitespace-obfuscated javascript: schemes", () => {
  for (const bad of [
    `<a href="jav&#9;ascript:alert(1)">x</a>`,
    `<a href="&#106;avascript:alert(1)">x</a>`,
    `<a href="javascript&#58;alert(1)">x</a>`,
    `<a href="vbscript:msgbox(1)">x</a>`,
    `<img src="data:text/html;base64,PHN2Zz4=">`,
  ]) {
    const out = sanitizeHtml(bad);
    assert.equal(/javascript|vbscript|data:/i.test(out.toLowerCase().replace(/&#\d+;/g, "")), false);
    assert.match(out, /=("|')#("|')|>x<\/a>|<img/);
  }
});
