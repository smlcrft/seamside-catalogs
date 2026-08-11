import assert from "node:assert/strict";
import { decodeEntities, stripCdata, parseDate } from "./text.ts";

Deno.test("decodeEntities named + numeric", () => {
  assert.equal(decodeEntities("A &amp; B &lt;x&gt; &#39;q&#39; &#x2F;"), "A & B <x> 'q' /");
});
Deno.test("stripCdata unwraps", () => {
  assert.equal(stripCdata("<![CDATA[hi <b>there</b>]]>"), "hi <b>there</b>");
});
Deno.test("parseDate handles RFC822 and ISO and junk", () => {
  assert.equal(typeof parseDate("Tue, 10 Jun 2025 09:00:00 GMT"), "number");
  assert.equal(typeof parseDate("2025-06-10T09:00:00Z"), "number");
  assert.equal(parseDate("not a date"), null);
  assert.equal(parseDate(null), null);
});
