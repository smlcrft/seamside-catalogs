import type { ParsedItem } from "./parser.ts";

export type ExistingItem = { _row_id: string; guid: string; published_at: number | null; fetched_at: number };

function rank(published_at: number | null, fetched_at: number): number {
  return published_at ?? fetched_at ?? 0;
}

export function planMerge(existing: ExistingItem[], parsed: ParsedItem[], cap: number): {
  toInsert: ParsedItem[]; toPrune: string[];
} {
  const have = new Set(existing.map((e) => e.guid));
  const newItems = parsed.filter((p) => !have.has(p.guid));

  const now = Number.MAX_SAFE_INTEGER;
  type Cand =
    | { kind: "existing"; id: string; r: number }
    | { kind: "new"; item: ParsedItem; r: number };
  const candidates: Cand[] = [
    ...existing.map((e) => ({ kind: "existing" as const, id: e._row_id, r: rank(e.published_at, e.fetched_at) })),
    ...newItems.map((p) => ({ kind: "new" as const, item: p, r: p.published_at ?? now })),
  ].sort((a, b) => b.r - a.r);

  const survivors = candidates.slice(0, cap);
  const survivorNew = new Set(survivors.flatMap((c) => c.kind === "new" ? [c.item] : []));
  const survivorExistingIds = new Set(survivors.flatMap((c) => c.kind === "existing" ? [c.id] : []));

  const toInsert = newItems.filter((p) => survivorNew.has(p));
  const toPrune = existing.filter((e) => !survivorExistingIds.has(e._row_id)).map((e) => e._row_id);
  return { toInsert, toPrune };
}
