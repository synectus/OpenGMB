/** `post` and `profile` are implicit for their content type only (never stored per workspace, never run on replies). */
export type PackId = "universal" | "hipaa" | "legal_ethics" | "post" | "profile";
export type ContentType = "reply" | "post" | "profile";
export type Severity = "block" | "warn";
export type RuleStatus = "active" | "pending_counsel_review";

/**
 * What a post carries besides its summary. Loosely typed on purpose: the guardrails must be able to
 * see (and reject) malformed values, so dates are `YYYY-MM-DD`, times `HH:MM`, strings unchecked.
 */
export interface PostFields {
  topicType: "STANDARD" | "EVENT" | "OFFER" | "ALERT";
  alertType: string | null;
  cta: { actionType: string; url?: string | null } | null;
  event: {
    title?: string | null;
    startDate?: string | null;
    startTime?: string | null;
    endDate?: string | null;
    endTime?: string | null;
  } | null;
  offer: {
    couponCode?: string | null;
    redeemOnlineUrl?: string | null;
    termsConditions?: string | null;
  } | null;
  media: { sourceUrl: string }[];
}

/**
 * The profile fields about to be written (only the ones being changed). Loosely typed on purpose,
 * like PostFields: the rules must be able to see and reject malformed values. Every key is part of
 * the guardrail subject, so a field changed after the check cannot ride on an earlier pass.
 */
export interface ProfileGuardFields {
  title?: string;
  description?: string;
  regularHours?: { periods?: unknown[] } | null;
  specialHours?: { specialHourPeriods?: unknown[] } | null;
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] } | null;
  [other: string]: unknown;
}

export interface GuardrailContext {
  /**
   * `reply` (default when absent): every existing reply path. `post`: `reply` holds the post
   * summary, `post` holds the rest, `review` is empty and `recentReplies` is `[]`. Rules run for a
   * content type only if they list it in `Rule.contentTypes`.
   */
  contentType?: ContentType;
  post?: PostFields;
  /** `profile`: `reply` holds the new description (empty when it is not being changed). */
  profile?: ProfileGuardFields;
  /** The text being checked: the reply, the post summary, or the profile description. */
  reply: string;
  review: {
    rating: 1 | 2 | 3 | 4 | 5 | null;
    text: string | null;
    reviewerDisplayName: string | null;
  };
  location: { name: string; phone: string | null };
  workspace: {
    profile: "general" | "healthcare" | "legal";
    packs: PackId[];
    skipPositiveReviews: boolean;
    staffNames: string[];
    /**
     * Per-workspace severity overrides applied by the engine AFTER `Rule.check`. Key is a rule id
     * (`H2.staff`) or a prefix pattern ending in `.*` (`H2.*` = every rule whose id starts `H2.`).
     * Rules and their messages never see it. Absent = each rule's own severity.
     */
    severityOverrides?: Record<string, Severity>;
  };
  /** Last N published replies for this location, newest first. */
  recentReplies: string[];
}

export interface Violation {
  ruleId: string;
  packId: PackId;
  severity: Severity;
  /** Copied from the rule, so a `pending_counsel_review` rule is visible in the result. */
  status: RuleStatus;
  message: string;
  /** Offsets index the ORIGINAL reply string. */
  matches?: { text: string; start: number; end: number }[];
}

export interface Rule {
  id: string;
  packId: PackId;
  description: string;
  severity: Severity;
  status: RuleStatus;
  /** Content types this rule runs for. Absent = replies only, so reply rules never touch posts. */
  contentTypes?: readonly ContentType[];
  /**
   * Returns violations WITHOUT status; the engine stamps rule.status. Rules therefore cannot
   * forget or misreport it.
   */
  check(ctx: GuardrailContext): Omit<Violation, "status">[];
}

export interface GuardrailResult {
  /** True when there is no block-severity violation. */
  ok: boolean;
  violations: Violation[];
  /** Packs that actually ran, `universal` first. */
  packs: PackId[];
}
