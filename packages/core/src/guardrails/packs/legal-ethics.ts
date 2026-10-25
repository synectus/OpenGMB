import { compileLexicon, findMatches, maskPhrase, type TextMatch } from "../text";
import type { ContentType, GuardrailContext, Rule, Severity } from "../types";
import { say, type Wording } from "./wording";

/**
 * Every rule here is `pending_counsel_review`: the wording comes from the playbook's legal line
 * ("default no reply or restrained wording; never confirm a client relationship, never discuss case
 * facts, no guarantees or testimonial language") and Texas Professional Ethics Committee Opinion
 * 662, and has not been signed off by counsel. The rules run and report with that status.
 *
 * Severity choices (documented for counsel to confirm):
 * - relationship and case facts: block. Confirming a representation or discussing a matter in a
 *   public reply is the core confidentiality problem Opinion 662 addresses.
 * - guarantee: block. A promise of results is a misleading claim whatever the reviewer wrote.
 * - testimonial wording: warn. It is softer and more context dependent, so a human may keep it
 *   after acknowledging the warning.
 */

const RELATIONSHIP_RE = compileLexicon([
  "thank(s| you) for (choosing|hiring|trusting|retaining|selecting) (us|our (firm|office|team|attorneys?|lawyers?))( as your (attorneys?|lawyers?|law firm))?",
  "as your (attorneys?|lawyers?|counsel|law firm)",
  "your (cases?|matters?|claims?|lawsuits?|settlements?|divorce|hearing|trial|representation)",
  "we represented you",
  "we('re| are| were) your (attorneys?|lawyers?|counsel)",
  "representing you",
  "our client",
  "you as our client",
]);

const CASE_FACT_RES = [
  compileLexicon([
    "settle(ment|ments|d)",
    "verdicts?",
    "lawsuits?",
    "courts?",
    "judges?",
    "trials?",
    "juries|jury",
    "plea (deal|bargain)",
    "custody",
    "indictments?",
    "damages",
    "\\d[\\d,]* dollars",
  ]),
  /(?<![\p{L}\p{N}])\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|million|thousand))?(?![\p{L}\p{N}])/giu,
];

const GUARANTEE_RE = compileLexicon([
  "guarantee(s|d)?",
  "we always win",
  "we will win",
  "we win",
  "100\\s?%",
  "best results",
  "never lose",
  "never lost",
  "win every",
]);

const TESTIMONIAL_RE = compileLexicon([
  "recommend us( to)?",
  "recommend (our|the) (firm|office|team)",
  "like you,? our clients",
  "clients like you",
  "satisfied clients",
  "happy clients",
  "tell your (friends|family)",
  "refer (us|your (friends|family))",
]);

function scrubbed(ctx: GuardrailContext): string {
  return maskPhrase(ctx.reply, ctx.location.name);
}

function rule(
  id: string,
  severity: Severity,
  description: string,
  message: Wording,
  find: (text: string) => TextMatch[],
  contentTypes?: readonly ContentType[],
): Rule {
  return {
    id,
    packId: "legal_ethics",
    ...(contentTypes ? { contentTypes } : {}),
    description: `${description} (Texas Opinion 662; pending counsel review)`,
    severity,
    status: "pending_counsel_review",
    check(ctx) {
      const matches = find(scrubbed(ctx)).sort((a, b) => a.start - b.start);
      if (matches.length === 0) return [];
      return [{ ruleId: id, packId: "legal_ethics", severity, message: say(ctx, message), matches }];
    },
  };
}

export const legalEthicsRules: Rule[] = [
  rule(
    "LE1.relationship",
    "block",
    "Never confirm or imply a client relationship: 'thank you for choosing us as your attorney', 'your case', 'we represented you', 'as your lawyer', 'our client'.",
    { reply: "Reply confirms or implies an attorney-client relationship." },
    (t) => findMatches(t, RELATIONSHIP_RE),
  ),
  rule(
    "LE2.case-facts",
    "block",
    "Never discuss case facts: settlement, verdict, court, lawsuit, judge, trial, dollar amounts.",
    { reply: "Reply mentions case facts." },
    (t) => CASE_FACT_RES.flatMap((re) => findMatches(t, re)),
  ),
  rule(
    "LE3.guarantee",
    "block",
    "No guarantees or promises of results: 'guarantee', 'we always win', '100%', 'best results', 'never lose'.",
    {
      reply: "Reply guarantees or promises results.",
      post: "The post guarantees or promises results.",
    },
    (t) => findMatches(t, GUARANTEE_RE),
    ["reply", "post"],
  ),
  rule(
    "LE4.testimonial",
    "warn",
    "No testimonial or endorsement-soliciting wording: 'recommend us to', 'like you, our clients'.",
    {
      reply: "Reply uses testimonial or endorsement wording.",
      post: "The post uses testimonial or endorsement wording.",
    },
    (t) => findMatches(t, TESTIMONIAL_RE),
    ["reply", "post"],
  ),
];
