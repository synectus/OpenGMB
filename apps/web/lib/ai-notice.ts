// Facts shown in the one-time AI notice. They are Anthropic's, not ours, so each carries its source and the day it was read.
export const AI_NOTICE_FACTS = {
  provider: "Anthropic",
  /** Anthropic deletes API inputs and outputs within this many days (longer only for policy violations or legal holds). */
  retentionDays: 30,
  sourceUrl: "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
  verifiedOn: "2026-10-25",
} as const;
