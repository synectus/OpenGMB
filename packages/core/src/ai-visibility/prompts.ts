import { AI_VISIBILITY } from "../config/ai-visibility";

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The prompts of one check: "best <category> in <city>" first, then the tracked keywords phrased the way
 * a person would ask for a local business. No duplicates, at most `promptsPerCheck`.
 */
export function buildPrompts(p: { category: string; city: string; keywords: readonly string[] }, limit: number = AI_VISIBILITY.promptsPerCheck): string[] {
  const category = clean(p.category);
  const city = clean(p.city);
  const candidates: string[] = [];
  if (category && city) candidates.push(`best ${category} in ${city}`);
  for (const k of p.keywords) {
    const kw = clean(k);
    if (!kw) continue;
    const lower = kw.toLowerCase();
    // A keyword that already names the city is used as it is; otherwise it gets the city.
    candidates.push(city && !lower.includes(city.toLowerCase()) ? `best ${kw} in ${city}` : kw);
  }
  if (category && city) candidates.push(`top rated ${category} near ${city}`, `who is the most recommended ${category} in ${city}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const text = c.slice(0, AI_VISIBILITY.maxPromptChars);
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
