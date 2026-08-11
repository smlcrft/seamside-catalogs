export function looksLikeFeed(text: string): boolean {
  const head = text.slice(0, 1000).toLowerCase();
  return head.includes("<rss") || head.includes("<feed") ||
    (head.includes("<?xml") && head.includes("<channel"));
}

export function discoverFeedUrl(html: string, baseUrl: string): string | null {
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    const rel = tag.match(/rel\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? "";
    const type = tag.match(/type\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? "";
    const href = tag.match(/href\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
    if (!href) continue;
    if (rel.includes("alternate") && (type.includes("rss") || type.includes("atom") || type.includes("xml"))) {
      try { return new URL(href, baseUrl).toString(); } catch { continue; }
    }
  }
  return null;
}
