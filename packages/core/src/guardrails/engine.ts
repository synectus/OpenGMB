import { PACK_ORDER, PACK_RULES } from "./packs";
import { postSubject } from "./post-subject";
import { profileSubject } from "./profile-subject";
import type { GuardrailContext, GuardrailResult, PackId, Severity, Violation } from "./types";

declare const passedBrand: unique symbol;

/**
 * Proof that `reply` was checked by `runGuardrails` and had no block-severity violation. The only
 * constructor is `assertPassed`; code that sends a reply to Google must require this type.
 */
export interface GuardrailPassed {
  readonly [passedBrand]: true;
  readonly reply: string;
  readonly result: GuardrailResult;
}

export class GuardrailBlockedError extends Error {
  constructor(public readonly result: GuardrailResult) {
    const ids = result.violations.filter((v) => v.severity === "block").map((v) => v.ruleId);
    super(`Reply blocked by guardrails: ${ids.join(", ")}`);
    this.name = "GuardrailBlockedError";
  }
}

/**
 * What a result is bound to: the reply text, or for posts a canonical serialisation of EVERY field
 * that would be sent (summary, topic, CTA, event, offer, media), so a CTA URL changed after the
 * check cannot ride on an earlier pass.
 */
export function guardrailSubject(ctx: GuardrailContext): string {
  if (ctx.contentType === "profile" && ctx.profile) return profileSubject(ctx.profile);
  return ctx.contentType === "post" && ctx.post ? postSubject(ctx.reply, ctx.post) : ctx.reply;
}

/** Reply text each issued result was computed for, so a result cannot be re-used for other text. */
const issued = new WeakMap<GuardrailResult, string>();

/** The override for `ruleId`: an exact key wins over a `<prefix>.*` pattern. */
function overrideFor(
  overrides: Record<string, Severity> | undefined,
  ruleId: string,
): Severity | undefined {
  if (!overrides) return undefined;
  if (Object.hasOwn(overrides, ruleId)) return overrides[ruleId];
  for (const [pattern, severity] of Object.entries(overrides)) {
    if (pattern.endsWith(".*") && ruleId.startsWith(pattern.slice(0, -1))) return severity;
  }
  return undefined;
}

/**
 * Run `universal` plus every pack the workspace enabled. Pure and deterministic: same context,
 * same result, rules in fixed pack order. `pending_counsel_review` rules run like any other and
 * their violations carry that status.
 */
export function runGuardrails(ctx: GuardrailContext): GuardrailResult {
  const type = ctx.contentType ?? "reply";
  const enabled = new Set<PackId>(["universal", ...ctx.workspace.packs]);
  for (const implicit of ["post", "profile"] as const) {
    if (type === implicit) enabled.add(implicit);
    else enabled.delete(implicit);
  }
  const packs = PACK_ORDER.filter((p) => enabled.has(p));
  const violations: Violation[] = [];
  for (const pack of packs) {
    for (const rule of PACK_RULES[pack]) {
      if (!(rule.contentTypes ?? ["reply"]).includes(type)) continue;
      for (const v of rule.check(ctx)) {
        const severity = overrideFor(ctx.workspace.severityOverrides, v.ruleId) ?? v.severity;
        violations.push({ ...v, severity, status: rule.status });
      }
    }
  }
  const result: GuardrailResult = Object.freeze({
    ok: !violations.some((v) => v.severity === "block"),
    violations: Object.freeze(violations) as Violation[],
    packs,
  });
  issued.set(result, guardrailSubject(ctx));
  return result;
}

/**
 * `result` plus violations found by running the rules on other text that belongs to the same subject
 * (a profile's service descriptions). The new result is bound to `ctx`'s subject like any other, so
 * `assertPassed` accepts it.
 */
export function withExtraViolations(
  result: GuardrailResult,
  ctx: GuardrailContext,
  extra: Violation[],
): GuardrailResult {
  if (extra.length === 0) return result;
  const violations = [...result.violations, ...extra];
  const merged: GuardrailResult = Object.freeze({
    ok: !violations.some((v) => v.severity === "block"),
    violations: Object.freeze(violations) as Violation[],
    packs: result.packs,
  });
  issued.set(merged, guardrailSubject(ctx));
  return merged;
}

/**
 * The only way to obtain a `GuardrailPassed`. Throws if the result has a block, was not produced
 * by `runGuardrails`, or was computed for different reply text than the one being sent.
 */
export function assertPassed(result: GuardrailResult, reply: string): GuardrailPassed {
  const checkedReply = issued.get(result);
  if (checkedReply === undefined) {
    throw new Error("assertPassed: result was not produced by runGuardrails");
  }
  if (checkedReply !== reply) {
    throw new Error("assertPassed: reply differs from the text that was checked");
  }
  if (!result.ok) throw new GuardrailBlockedError(result);
  return Object.freeze({ reply, result }) as unknown as GuardrailPassed;
}
