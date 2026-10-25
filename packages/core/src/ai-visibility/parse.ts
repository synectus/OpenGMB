import { AI_VISIBILITY, type AiEngine } from "../config/ai-visibility";

/** What one engine answered, reduced to the text and the domains it cited. */
export type Answer = { text: string; domains: string[] };

export type Parsed = {
  mentioned: boolean;
  /** Order of first appearance among the businesses named in the answer (1 = named first); null when the business is not named. */
  position: number | null;
  competitors: string[];
  sourceDomains: string[];
  excerpt: string;
};

const TEXT_KEYS = new Set(["markdown", "text", "original_text"]);

const domainOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * Pull the answer text and cited domains out of one DataForSEO result. The four engines nest their text differently
 * (documented shapes: scraper `items[].markdown`, LLM Responses `items[].sections[].text`, SERP `items[]` of type
 * ai_overview with `items[].text` and `references[]`), so this walks the part that holds the answer and collects the
 * text fields and the `domain` / `url` of its sources.
 */
export function answerOf(engine: AiEngine, result: unknown): Answer {
  const root = result as Record<string, unknown> | null;
  let scope: unknown = root;
  if (engine === "ai_overview") {
    const items = (root?.items as { type?: string }[] | undefined) ?? [];
    scope = items.filter((i) => i.type === "ai_overview");
  }
  const texts: string[] = [];
  const domains = new Set<string>();
  const seenText = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 12 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        if (TEXT_KEYS.has(k) && v.trim() && !seenText.has(v)) {
          seenText.add(v);
          texts.push(v);
        } else if (k === "domain" && v) domains.add(v.replace(/^www\./, ""));
        else if ((k === "url" || k === "direct_url") && v) {
          const d = domainOf(v);
          if (d) domains.add(d);
        }
      } else walk(v, depth + 1);
    }
  };
  walk(scope, 0);
  return { text: texts.join("\n"), domains: [...domains] };
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** First index of `name` (as whole words) in the already normalised text, or -1. */
function indexOfName(normText: string, name: string): number {
  const n = norm(name);
  if (n.length < 3) return -1;
  return (` ${normText} `).indexOf(` ${n} `);
}

/** Decide whether the business is named, where, and which known competitors are named too. */
export function parseAnswer(answer: Answer, business: string, knownCompetitors: readonly string[]): Parsed {
  const text = norm(answer.text);
  const own = indexOfName(text, business);
  const found = new Map<string, number>();
  for (const c of knownCompetitors) {
    if (norm(c) === norm(business)) continue;
    const at = indexOfName(text, c);
    if (at >= 0) found.set(c, at);
  }
  const competitors = [...found.entries()].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const mentioned = own >= 0;
  const position = mentioned ? 1 + [...found.values()].filter((at) => at < own).length : null;
  return {
    mentioned,
    position,
    competitors,
    sourceDomains: answer.domains.slice(0, 20),
    excerpt: answer.text.slice(0, AI_VISIBILITY.excerptChars),
  };
}
