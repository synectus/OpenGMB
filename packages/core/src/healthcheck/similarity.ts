import { HEALTHCHECK_CONFIG as CFG } from "../config/healthcheck";

/** Lowercase letters and digits only, words split on anything else. */
export const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Words too common to mean anything when matching a description to a search term. */
const STOP = new Set(["the", "and", "for", "near", "me", "in", "of", "a", "an", "to", "at", "my"]);
/** Crude plural fold so "dentists" matches "dentist". */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);

/** Which search terms have every meaningful word present in the text. */
export function keywordsCovered(text: string, keywords: string[]): { covered: string[]; missing: string[] } {
  const have = new Set(words(text).map(stem));
  const covered: string[] = [];
  const missing: string[] = [];
  for (const k of keywords) {
    const need = words(k)
      .filter((w) => !STOP.has(w))
      .map(stem);
    (need.length > 0 && need.every((w) => have.has(w)) ? covered : missing).push(k);
  }
  return { covered, missing };
}

/** Problems that make a description read as spam or as unfinished. Empty when it looks fine. */
export function descriptionProblems(text: string): string[] {
  const problems: string[] = [];
  const len = [...text].length;
  if (len < CFG.minDescriptionChars)
    problems.push(`only ${len} characters, recommended at least ${CFG.minDescriptionChars}`);
  const letters = text.replace(/[^\p{L}]/gu, "");
  const upper = letters.replace(/[^\p{Lu}]/gu, "");
  if (letters.length >= 20 && upper.length / letters.length > CFG.maxUppercaseShare)
    problems.push("mostly capital letters");
  const counts = new Map<string, number>();
  for (const w of words(text)) if (w.length >= 4 && !STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const stuffed = [...counts].filter(([, n]) => n > CFG.maxWordRepeats).map(([w]) => w);
  if (stuffed.length)
    problems.push(`repeats "${stuffed[0]}" more than ${CFG.maxWordRepeats} times (reads as keyword stuffing)`);
  return problems;
}

/** Dice coefficient over character bigrams of the normalised text, 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = words(a).join(" ");
  const y = words(b).join(" ");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const [g, n] of gx) hit += Math.min(n, gy.get(g) ?? 0);
  return (2 * hit) / (Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0));
}

/** Last digits of a phone number, enough to ignore country code and punctuation; null when too short. */
export const phoneKey = (p: string | null | undefined): string | null => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= CFG.phoneMatchDigits ? d.slice(-CFG.phoneMatchDigits) : null;
};

export type ListingId = { name: string; address: string | null; phone: string | null };

/**
 * Two listings look like duplicates when the names are near-identical AND the address or phone
 * agrees, or the address and phone both agree under any name (a rename left behind). A shared phone
 * or a shared building alone is not enough: chains share call-centre numbers, clinics share buildings.
 */
export function looksDuplicate(a: ListingId, b: ListingId): boolean {
  const name = similarity(a.name, b.name) >= CFG.duplicateNameSimilarity;
  const addr = !!a.address && !!b.address && similarity(a.address, b.address) >= CFG.duplicateAddressSimilarity;
  const pa = phoneKey(a.phone);
  const phone = pa !== null && pa === phoneKey(b.phone);
  return (name && (addr || phone)) || (addr && phone);
}
