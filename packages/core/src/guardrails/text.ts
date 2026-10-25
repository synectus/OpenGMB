export interface TextMatch {
  text: string;
  start: number;
  end: number;
}

/** Any run of non-letter/digit characters: whitespace, punctuation, dashes, smart quotes. */
const SEP = "[^\\p{L}\\p{N}]+";
/** Straight and typographic apostrophes. */
const APOS = "['’‘ʼ`´]";

/**
 * Mini-syntax for lexicon entries: ordinary regex source, except that a space matches any run of
 * non-alphanumerics and an apostrophe matches any apostrophe form or none ("can't" == "can’t" ==
 * "cant"). Case is ignored. Do not put spaces inside [...] classes.
 */
function toSource(entry: string): string {
  return entry.replace(/ /g, SEP).replace(/['’‘ʼ`´]/g, `${APOS}?`);
}

/** Compile lexicon entries into one global, case-insensitive, word-bounded RegExp. */
export function compileLexicon(entries: readonly string[]): RegExp {
  if (entries.length === 0) throw new Error("compileLexicon: empty lexicon");
  const body = entries.map((e) => `(?:${toSource(e)})`).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "giu");
}

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive literal (flexible separators between its words). */
export function compileLiteral(literal: string): RegExp {
  const words = literal.trim().split(/\s+/).map(escapeRegExp);
  return compileLexicon([words.join(" ")]);
}

/** All matches of `re` in `text`, with offsets into `text` itself (never a normalised copy). */
export function findMatches(text: string, re: RegExp): TextMatch[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const g = new RegExp(re.source, flags);
  const out: TextMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Comparison form: NFKC, lowercase, apostrophes dropped (so "can’t" == "can't" == "cant"), every
 * other non-alphanumeric run becomes one space.
 */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’‘ʼ`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** First sentence of `text` (up to the first . ! ? or line break), original characters. */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /[.!?]+(?=\s|$)|\n/.exec(t);
  return m ? t.slice(0, m.index) : t;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Replace every occurrence of `needle` (whole-word, flexible separators) with spaces of the same
 * length, so later offsets still index the original string. Used to exempt the location's own name.
 */
export function maskPhrase(text: string, needle: string): string {
  if (needle.trim().length === 0) return text;
  let out = text;
  for (const m of findMatches(text, compileLiteral(needle))) {
    out = out.slice(0, m.start) + " ".repeat(m.end - m.start) + out.slice(m.end);
  }
  return out;
}

/** Word tokens (apostrophes dropped inside words) with offsets into `text`. */
export function tokenise(text: string): { token: string; start: number; end: number }[] {
  const out: { token: string; start: number; end: number }[] = [];
  const re = /[\p{L}\p{N}]+(?:['’‘ʼ][\p{L}\p{N}]+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      token: m[0].toLowerCase().replace(/['’‘ʼ]/g, ""),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}
