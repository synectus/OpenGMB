const WORD = "\\p{L}\\p{N}";

/** Lower-case, one space between words, punctuation other than apostrophes and hyphens turned into spaces. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(new RegExp(`[^${WORD}'\\-\\s]`, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which of `keywords` the text contains, as whole words in the same order (a plural "s" or "es" on the
 * last word still counts). Used to tell a person which Performance keywords a draft happens to include;
 * it never changes the draft. Returns the keywords in the spelling they were given.
 */
export function keywordsIn(text: string, keywords: string[]): string[] {
  const hay = ` ${norm(text)} `;
  return keywords.filter((k) => {
    const n = norm(k);
    if (n === "") return false;
    return new RegExp(`(?<![${WORD}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?(?![${WORD}])`, "u").test(hay);
  });
}
