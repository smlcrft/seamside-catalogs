// Which members list this session uses: `members.table.jsonl` at the space's root, or a
// subtype such as `club.members.table.jsonl`. An editor chooses, and always confirms; the
// worker keeps the choice per session (sessionKv `bound/members`). Companion frames agree by
// the person choosing the same list in each.
import { frame, html } from "./lib/js/framelib.js";

export const LIST_NAME = /^([a-z0-9][a-z0-9_-]*\.)*members$/;
const TABLE_FILE = /^(.+)\.table\.jsonl$/;

export const listLabel = (name) => (name === "members" ? "members" : String(name).replace(/\.members$/, ""));

/** The space's members lists, with how many people each holds. */
export async function listsInSpace() {
  const entries = await window.seamside.data.tree("");
  const names = entries
    .filter((e) => !e.dir)
    .map((e) => TABLE_FILE.exec(e.name)?.[1])
    .filter((n) => n && n.length <= 64 && LIST_NAME.test(n))
    .sort();
  return Promise.all(names.map(async (name) => ({ name, rows: (await window.seamside.data.table(name).all()).length })));
}

/** Ask the person which list to use: the lists there are, plus New list…. The name, or null. */
export async function chooseList(current) {
  const lists = await listsInSpace().catch(() => []);
  const options = lists.map((l) => ({
    id: l.name,
    label: listLabel(l.name),
    icon: "ph-users-three",
    detail: `${l.name}.table.jsonl · ${l.rows} ${l.rows === 1 ? "person" : "people"}${l.name === current ? " · in use" : ""}`,
  }));
  options.push({ id: "__new", label: "New list…", icon: "ph-plus" });
  const picked = await frame.choose(
    lists.length ? "Which members list should this use?" : "There is no members list in this space yet.",
    { title: "Members list", options },
  );
  if (picked !== "__new") return picked;
  const taken = new Set(lists.map((l) => l.name));
  for (;;) {
    const raw = await frame.prompt("A short name, such as club or choir. Leave it blank for the space's plain members list.", { title: "New list", okLabel: "Create", placeholder: "club" });
    if (raw === null) return null;
    const slug = String(raw).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 40);
    if (slug) return `${slug}.members`;
    if (!taken.has("members")) return "members";
    await frame.alert("The space already has a plain members list. Give the new one a name.");
  }
}

/** The members list this session was opened on (`?open=club.members.table.jsonl`), or null. */
export function openedList() {
  const m = TABLE_FILE.exec(window.seamside?.data?.open ?? "");
  return m && LIST_NAME.test(m[1]) ? m[1] : null;
}

/** On load, for an editor: bind the list the session was opened on, or ask for one while
 *  unbound. `bind(name)` asks the worker. */
export async function settleList({ bound, can_bind }, bind) {
  if (!can_bind) return;
  const opened = openedList();
  if (opened && opened !== bound) {
    const now = bound ? ` It uses ${listLabel(bound)} now.` : "";
    if (await frame.confirm(`Use the ${listLabel(opened)} list (${opened}.table.jsonl) here?${now}`, { title: "Members list", okLabel: "Use it" })) return bind(opened);
  }
  if (!bound) {
    const name = await chooseList(null);
    if (name) return bind(name);
  }
}

/** The line that says which list is in use, with Change for an editor. */
export function ListLine({ bound, canBind, onChoose }) {
  if (canBind) {
    return html`
      <p class="list-line">
        <i class="ph-light ph-users-three"></i>
        <span>Members list: <strong>${bound ? listLabel(bound) : "none yet"}</strong></span>
        <button class="list-line__change" onClick=${onChoose}>${bound ? "Change" : "Choose"}</button>
      </p>`;
  }
  if (!bound) return html`<p class="list-line">An editor picks which members list this uses.</p>`;
  return null;
}
