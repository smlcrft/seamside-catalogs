import assert from "node:assert/strict";
import { planMerge } from "./merge.ts";

Deno.test("planMerge inserts only new guids", () => {
  const existing = [{ _row_id: "r1", guid: "a", published_at: 100, fetched_at: 100 }];
  const parsed = [
    { guid: "a", title: "", link: "", author: "", content: "", published_at: 100 },
    { guid: "b", title: "", link: "", author: "", content: "", published_at: 200 },
  ];
  const { toInsert } = planMerge(existing, parsed, 80);
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].guid, "b");
});

Deno.test("planMerge prunes oldest beyond cap", () => {
  const existing = [
    { _row_id: "r1", guid: "old", published_at: 1, fetched_at: 1 },
    { _row_id: "r2", guid: "mid", published_at: 5, fetched_at: 5 },
  ];
  const parsed = [{ guid: "new", title: "", link: "", author: "", content: "", published_at: 9 }];
  const { toPrune } = planMerge(existing, parsed, 2);
  assert.deepEqual(toPrune, ["r1"]); // keep newest 2: new(9), mid(5); drop old(1)
});

Deno.test("planMerge caps inserts when a first pull exceeds cap", () => {
  const parsed = [
    { guid: "p1", title: "", link: "", author: "", content: "", published_at: 10 },
    { guid: "p2", title: "", link: "", author: "", content: "", published_at: 30 },
    { guid: "p3", title: "", link: "", author: "", content: "", published_at: 20 },
  ];
  const { toInsert, toPrune } = planMerge([], parsed, 1);
  assert.equal(toInsert.length, 1);
  assert.equal(toInsert[0].guid, "p2"); // newest survives
  assert.deepEqual(toPrune, []);
});
