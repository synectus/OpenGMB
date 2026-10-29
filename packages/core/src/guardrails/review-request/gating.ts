import { compileLexicon, findMatches } from "../text";

/**
 * Review-request wording check (W12a). Flags wording in a message that ASKS for a review when it
 * selects who is asked, steers the answer, or offers something in return. Built on the guardrail
 * engine's lexicon matcher (`guardrails/text.ts`), and shaped like its violations, but it is not one
 * of the workspace packs: it runs in the browser on the free review request templates page and
 * stores nothing. Pure and deterministic, so a message either passes or it does not.
 *
 * Source, read on 2026-10-27 (Google "Prohibited and restricted content" policy for Maps user
 * contributions). The policy does not use the words "review gating"; the lines it does use are:
 *   - Merchants may not "Discourage or prohibit negative reviews, or selectively solicit positive
 *     reviews from customers" (Rating Manipulation).
 *   - "Content that has been posted due to an incentive offered by a business" is an incentivized
 *     review, and "Reviews or ratings that have been paid for, directly or in kind" is fake engagement.
 * Google changes this page. Re-read it before widening these rules, and update `readOn`.
 */
export const REVIEW_REQUEST_POLICY = {
  sourceUrl: "https://support.google.com/contributionpolicy/answer/7400114",
  readOn: "2026-10-27",
  lines: [
    "Discourage or prohibit negative reviews, or selectively solicit positive reviews from customers",
    "Content that has been posted due to an incentive offered by a business",
    "Reviews or ratings that have been paid for, directly or in kind",
  ],
} as const;

export type GatingSeverity = "block" | "warn";

export interface GatingRule {
  id: string;
  severity: GatingSeverity;
  /** What the rule looks for, one line. */
  description: string;
  /** Which policy line it rests on, or why it is only a warning. */
  basis: string;
  /** What the visitor sees when the rule fires. */
  message: string;
  lexicon: readonly string[];
}

const SELECT = REVIEW_REQUEST_POLICY.lines[0];
const INCENTIVE = REVIEW_REQUEST_POLICY.lines[1];

export const GATING_RULES: readonly GatingRule[] = [
  {
    id: "GATE.conditional",
    severity: "block",
    description: "Asks only if the customer was happy or satisfied",
    basis: `Policy: "${SELECT}"`,
    message: "This asks only customers who had a good experience. Google does not allow choosing who to ask by how they felt. Ask everyone the same way.",
    lexicon: [
      "if you (?:had|have|enjoyed|loved|liked) (?:a |an |your |our |the )?(?:good|great|positive|wonderful|excellent|amazing|pleasant|happy|nice)",
      "if you(?:'re| are| were) (?:happy|satisfied|pleased|delighted|impressed|thrilled|glad)",
      "if (?:we|i) (?:did|made|were|was) (?:a )?(?:good|great|well|helpful|happy)",
      "if you (?:would|'d) recommend us",
      "if you(?:'re| are| were) (?:a )?(?:happy|satisfied) customer",
      "if you (?:loved|liked|enjoyed) (?:it|us|our|your|the|what|working)",
      "only (?:if|when) you(?:'re| are| were)? (?:happy|satisfied|pleased)",
    ],
  },
  {
    id: "GATE.rate-first",
    severity: "block",
    description: "Asks how the customer rates the experience before sending the review link",
    basis: `Policy: "${SELECT}"`,
    message: "This asks for a rating or feedback first, which sorts happy customers from unhappy ones before the review link. Send the link to everyone, and take private feedback separately.",
    lexicon: [
      "how (?:would|did) you rate",
      "rate (?:your|our|the) (?:experience|visit|service|stay|appointment)",
      "on a scale of",
      "(?:1|one) to (?:5|five|10|ten)",
      "(?:take|complete|fill out|answer) (?:a |our |this )?(?:quick |short )?(?:survey|poll|questionnaire)",
      "(?:reply|text|respond) (?:with )?(?:a )?(?:number|rating|score)",
      "(?:leave|give|send) (?:us )?(?:private|direct) feedback",
      "tell us (?:privately|directly) (?:how|what)",
    ],
  },
  {
    id: "GATE.discourage-negative",
    severity: "block",
    description: "Steers unhappy customers away from posting a public review",
    basis: `Policy: "${SELECT}"`,
    message: "This steers unhappy customers away from a public review. Google does not allow discouraging negative reviews. Say that honest reviews of any kind are welcome.",
    lexicon: [
      "(?:instead of|rather than) (?:leaving|posting|writing|giving|putting) (?:a |an |it )?(?:negative|bad|public|online|poor|low)",
      "before (?:you )?(?:leave|leaving|post|posting|write|writing) (?:a |an )?(?:negative|bad|poor|low|public)",
      "(?:please )?(?:do not|don't|dont) (?:leave|post|write) (?:a |an )?(?:negative|bad|poor|low)",
      "give us (?:a |the )?chance to (?:make it right|fix|put it right|resolve|correct)",
      "(?:contact|call|email|text) us (?:first|before)",
      "if (?:anything|something) (?:went|was) wrong,? (?:contact|call|email|tell|reach|let) us",
      "if you(?:'re| are| were) (?:not|unhappy|dissatisfied|disappointed|upset)",
    ],
  },
  {
    id: "GATE.incentive",
    severity: "block",
    description: "Offers something in return for a review",
    basis: `Policy: "${INCENTIVE}"`,
    message: "This offers something in return for a review. Google does not allow reviews that were paid for, in cash or in kind. Remove the offer and just ask.",
    lexicon: [
      "discount",
      "coupon",
      "voucher",
      "gift (?:card|certificate)",
      "in (?:exchange|return) for",
      "rewards?",
      "raffle",
      "giveaway",
      "sweepstakes?",
      "(?:entered|enter you|be entered|entry) (?:in)?to (?:win|a draw|our draw)",
      "(?:chance|opportunity) to win",
      "win (?:a|an|one|our|free)",
      "prizes?",
      "free (?:gift|meal|drink|coffee|appetizer|dessert|item|product|upgrade|month)",
      "\\d+% off",
      "\\d+ percent off",
      "\\$\\d+ (?:off|credit|back)",
      "(?:store|account) credit",
      "loyalty points?",
      "cash back",
      "cashback",
    ],
  },
  {
    id: "GATE.stars",
    severity: "warn",
    description: "Asks for a specific star rating",
    basis: "Not named in the policy lines above. A warning because it steers the answer, and OpenGMB's own review request wording check refuses it too.",
    message: "This asks for a specific rating, such as 5 stars. Ask for an honest review and let the customer choose the rating.",
    lexicon: [
      "(?:5|five) stars?",
      "(?:a |the )?(?:top|perfect|highest|best) (?:rating|score|review)",
      "(?:positive|glowing|good|great|favorable|favourable) review",
    ],
  },
];

const COMPILED = GATING_RULES.map((r) => ({ rule: r, re: compileLexicon(r.lexicon) }));

export interface GatingViolation {
  ruleId: string;
  severity: GatingSeverity;
  message: string;
  /** Offsets into the checked text. */
  matches: { start: number; end: number }[];
}

export interface GatingResult {
  /** True when there is no block-severity violation. */
  ok: boolean;
  violations: GatingViolation[];
}

export function checkReviewRequest(text: string): GatingResult {
  const violations: GatingViolation[] = [];
  for (const { rule, re } of COMPILED) {
    const found = findMatches(text, re);
    if (found.length === 0) continue;
    violations.push({ ruleId: rule.id, severity: rule.severity, message: rule.message, matches: found.map(({ start, end }) => ({ start, end })) });
  }
  return { ok: !violations.some((v) => v.severity === "block"), violations };
}
