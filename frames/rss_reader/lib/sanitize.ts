import { decodeEntities } from "./text.ts";

const BLOCK_TAGS = ["script", "style", "iframe", "object", "embed", "form", "link", "meta"];
const ALLOWED_SCHEMES = ["http", "https", "mailto", "tel"];

function stripBlocks(html: string): string {
  let out = html;
  for (const tag of BLOCK_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }
  return out;
}

function safeUrls(html: string): string {
  return html.replace(/\b(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, attr, _raw, dq, sq, uq) => {
      const val = dq ?? sq ?? uq ?? "";
      // Normalize the way a browser would before dispatching the URL: decode entities,
      // drop control/space chars, lowercase — THEN test the scheme.
      const norm = decodeEntities(val).replace(/[\u0000-\u0020]/g, "").toLowerCase();
      const scheme = norm.match(/^([a-z][a-z0-9+.\-]*):/)?.[1];
      // No scheme = relative (safe). A scheme must be on the allowlist, else neutralize.
      if (scheme && !ALLOWED_SCHEMES.includes(scheme)) return `${attr}="#"`;
      return m;
    });
}

export function sanitizeHtml(html: string): string {
  if (!html) return "";
  let out = html;
  // Fixpoint: strip dangerous blocks + on* handler attributes until the string stops
  // changing. This defeats nested-decoy reconstruction (a removed inner tag can splice
  // two fragments back into a fresh dangerous tag that a single pass would miss).
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = stripBlocks(out);
    out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    if (out === before) break;
  }
  out = safeUrls(out);
  return out.trim();
}
