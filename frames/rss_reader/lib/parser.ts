import { decodeEntities, stripCdata, parseDate } from "./text.ts";

export type ParsedItem = {
  guid: string; title: string; link: string; author: string;
  content: string; published_at: number | null;
};

function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi");
  return xml.match(re) ?? [];
}

function tagText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return decodeEntities(stripCdata(m[1])).trim();
}

function attr(tagStr: string, name: string): string | null {
  const m = tagStr.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))
    ?? tagStr.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? m[1] : null;
}

function atomLink(entry: string): string {
  const links = entry.match(/<(?:[a-z0-9]+:)?link\b[^>]*\/?>/gi) ?? [];
  let fallback = "";
  for (const l of links) {
    const href = attr(l, "href") ?? "";
    const rel = (attr(l, "rel") ?? "alternate").toLowerCase();
    if (!href) continue;
    if (rel === "alternate") return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

export function parseFeed(xml: string, feedUrl: string): { title: string; items: ParsedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const channel = xml.match(/<channel[\s>][\s\S]*?<\/channel>/i)?.[0] ?? xml;
  const feedTitle = (isAtom ? tagText(xml, "title") : tagText(channel, "title")) ?? "Untitled feed";

  const rawEntries = isAtom ? blocks(xml, "entry") : blocks(xml, "item");
  const items: ParsedItem[] = rawEntries.map((raw) => {
    const title = tagText(raw, "title") ?? "(untitled)";
    const link = isAtom ? atomLink(raw) : ((tagText(raw, "link") ?? "") || atomLink(raw));
    const content =
      tagText(raw, "content:encoded") ?? tagText(raw, "content") ??
      tagText(raw, "description") ?? tagText(raw, "summary") ?? "";
    const author = isAtom
      ? (raw.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i)?.[1]?.trim() ?? "")
      : (tagText(raw, "dc:creator") ?? tagText(raw, "author") ?? "");
    const rawGuid = isAtom ? tagText(raw, "id") : tagText(raw, "guid");
    const dateStr = isAtom
      ? (tagText(raw, "updated") ?? tagText(raw, "published"))
      : (tagText(raw, "pubDate") ?? tagText(raw, "dc:date"));
    const guid = (rawGuid && rawGuid.length ? rawGuid : link) || `${feedUrl}#${title}`;
    return { guid, title, link, author: decodeEntities(author), content, published_at: parseDate(dateStr) };
  });

  return { title: feedTitle, items };
}
