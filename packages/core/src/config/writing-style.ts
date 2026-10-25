/**
 * Writing style for AI drafts. Distilled on 2026-10-21 from an internal writing guide (the sections on transitions, banned words,
 * openers, tone, and the market spelling and voice rules).
 * That guide targets web articles, so only what applies to a short review reply is here: no em dashes,
 * the banned words and phrases, no sycophantic or filler openers, plain human tone, and the market's
 * spelling and voice. Article-only parts (H1, FAQ, SEO keywords, long stories) are left out.
 *
 * The lists are data. The prompt reads them (ai/style.ts) and the guardrail rule U8.style scans for
 * them, so the model is asked and the output is checked against one source. To change the style,
 * change the lists here; nothing else holds a copy.
 */

export const EM_DASH = "—";

/** 3A transition words. */
export const BANNED_TRANSITIONS = [
  "furthermore", "moreover", "additionally", "subsequently", "accordingly", "consequently",
  "nevertheless", "nonetheless", "in conclusion", "to summarize", "in summary", "that being said",
  "having said that", "needless to say", "generally speaking", "broadly speaking",
  "with that in mind", "as we navigate", "it is worth noting", "it is important to note",
  "it goes without saying",
] as const;

/** 3B openers and filler phrases. */
export const BANNED_OPENERS = [
  "in today's", "in the ever-evolving landscape of", "this comprehensive guide will",
  "now more than ever", "certainly, here is", "as we delve into", "let us explore",
  "let's dive in", "let's dive into", "let's explore", "let's break this down",
  "here's what you need to know", "without further ado", "now let's look at",
  "at the end of the day", "at its core", "what really matters", "the heart of the matter",
  "when it comes to",
] as const;

/** 3C adjectives and power words. */
export const BANNED_ADJECTIVES = [
  "comprehensive", "robust", "pivotal", "crucial", "vital", "essential", "fundamental",
  "revolutionary", "transformative", "innovative", "cutting-edge", "dynamic", "seamless", "optimal",
  "holistic", "multifaceted", "nuanced", "intricate", "significant", "paramount", "remarkable",
  "commendable", "exemplary", "captivating", "enriching", "esteemed", "notable", "vibrant",
  "breathtaking", "stunning", "groundbreaking", "renowned", "nestled", "profound",
] as const;

/** 3D verbs, base form. Inflections (delves, delved, delving) are matched by the scanner. */
export const BANNED_VERBS = [
  "delve", "embark", "foster", "leverage", "utilize", "facilitate", "augment", "amplify", "elevate",
  "empower", "cultivate", "streamline", "underscore", "harness", "spearhead", "conceptualize",
  "glean", "tailor", "showcase", "boast", "navigate",
] as const;

/** 3E buzzword phrases. */
export const BANNED_BUZZWORDS = [
  "game-changer", "game changer", "deep dive", "actionable insights", "best practices",
  "competitive landscape", "digital transformation", "thought leadership", "value proposition",
  "going forward", "move the needle", "circle back", "synergy", "ecosystem", "paradigm shift",
  "disruptive innovation", "future-proof", "scalable solutions", "a testament to",
  "a pivotal moment", "a broader movement", "marks a shift", "setting the stage for",
] as const;

/** 4B copula avoidance: say "is", "are", "has" instead. */
export const BANNED_COPULA = ["serves as", "stands as", "functions as", "represents a", "acts as a"] as const;

/** 3F words Claude overuses (the unambiguous ones). */
export const BANNED_CLAUDE_TELLS = [
  "notably", "it's worth noting", "straightforward", "i'd be happy to", "let me walk you through",
  "it is important to understand",
] as const;

/** 3G recycled phrasing. */
export const BANNED_PHRASES = [
  "brutal clarity", "lost the plot", "painfully clear", "blunt honesty", "lived experience",
  "launching a new chapter", "laying the groundwork", "here's a breakdown", "i'll be honest",
  "i'll be real",
] as const;

/** 4S filler. */
export const BANNED_FILLER = [
  "in order to", "due to the fact that", "at this point in time", "has the ability to",
  "i hope this helps", "let me know if you need anything",
] as const;

/** 4V sycophantic openers: banned only at the start of the text. */
export const BANNED_STARTS = [
  "great question", "you're absolutely right", "that's an excellent point", "of course", "certainly",
] as const;

/**
 * Words the skill bans only in some uses (3F: overall as a filler, absolutely as an opener, typically,
 * various as a vague plural; 3G: not only ... but also). Asked for in the prompt, never scanned,
 * because a scan cannot tell the filler use from the honest one.
 */
export const AVOID_IN_PROMPT_ONLY = [
  "overall", "absolutely", "typically", "various", "not only ... but also",
] as const;

/** Every list the scanner matches anywhere in the text (BANNED_STARTS is matched at the start only). */
export const SCANNED_PHRASES: readonly string[] = [
  ...BANNED_TRANSITIONS, ...BANNED_OPENERS, ...BANNED_ADJECTIVES, ...BANNED_BUZZWORDS,
  ...BANNED_COPULA, ...BANNED_CLAUDE_TELLS, ...BANNED_PHRASES, ...BANNED_FILLER,
];

/** Rules of tone from sections 4 to 6 that apply to a short reply. */
export const TONE_RULES = [
  "Sound like a real person at the business typed this: plain words, no corporate polish.",
  "Vary sentence length on purpose. Mix short sentences with a longer one. Include at least one sentence under six words.",
  "Use simple verbs: is, are, has, does. Not 'serves as' or 'represents'.",
  "Say what you mean and be specific. No claims about how important something is.",
  "No groups of three abstract words, no 'it is not X, it is Y' lines, and no trailing phrases such as 'highlighting' or 'showcasing'.",
  "No sycophantic or filler openers, and no closing line such as 'I hope this helps'.",
] as const;

export type MarketCode = "us" | "au" | "in";
export const DEFAULT_MARKET: MarketCode = "us";

/** Spelling and voice per market (skill section 8 and the market file, cut down for a reply). */
export const MARKET_VOICE: Record<MarketCode, { label: string; spelling: string; voice: string }> = {
  us: {
    label: "United States",
    spelling: "American spelling (color, center, favorite, organize, license, practice).",
    voice: "Direct and confident, warm, speaking to 'you'. No regional slang.",
  },
  au: {
    label: "Australia",
    spelling: "Australian spelling (colour, centre, favourite, organise, licence for the noun).",
    voice: "Understated and down to earth. No hype, no exclamation marks, and at most one light local phrase such as 'no worries'.",
  },
  in: {
    label: "India",
    spelling: "Indian English spelling (colour, centre, favourite, organise).",
    voice: "Simple, polite and direct. Short plain words a customer reads easily.",
  },
};

/**
 * Which market a workspace writes in. The workspace has a time zone (set from its first location's
 * country) but no country field, so the zone decides: India zones are IN, Australian zones are AU,
 * everything else (and an unknown zone) is the default US.
 */
export function marketForTimeZone(timeZone: string | null | undefined): MarketCode {
  const tz = timeZone ?? "";
  if (tz === "Asia/Kolkata" || tz === "Asia/Calcutta") return "in";
  if (tz.startsWith("Australia/")) return "au";
  return DEFAULT_MARKET;
}
