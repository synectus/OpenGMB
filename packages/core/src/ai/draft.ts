import { effectiveCapMicroUsd } from "../limits/ai-cap";
import { z } from "zod";
import { aiUsage, type Tx } from "@opengmb/db";
import { assertCredit, debit, withMarkupMicro } from "../billing";
import { AccessError, type Actor } from "../actor";
import { AI_DEFAULTS } from "../config/ai-models";
import { CoreError } from "../errors";
import { runGuardrails, type GuardrailContext } from "../guardrails";
import type { ActionAuditEntry } from "../registry";
import { aiEnv, AI_NOT_SET_UP, getAiModel } from "./model";
import { assertAiEnabled } from "./switch";
import { costMicroUsd, estimateMaxCostMicroUsd } from "./money";
import { cleanEmDashes } from "./style";
import {
  lockAiBudget,
  platformSpentMicroUsd,
  workspaceCapMicroUsd,
  workspaceSpentMicroUsd,
} from "./usage";
import type { DraftPurpose } from "./voice";

export const draftOut = z.object({
  status: z.enum(["ok", "blocked"]),
  /** The draft. Null when the guardrails blocked it: a blocked text is never handed back. */
  draft: z.string().nullable(),
  blockedRuleIds: z.array(z.string()),
  warningRuleIds: z.array(z.string()),
  model: z.string(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costMicroUsd: z.number().int(),
});
export type DraftResult = z.infer<typeof draftOut>;

export type DraftRun = {
  workspaceId: string;
  purpose: DraftPurpose;
  system: string;
  user: string;
  /** Length of the source text, for the audit row (the text itself is never logged). */
  sourceChars: number;
  /** The guardrail context for the finished text. Reply drafts use the one the reply flow will use. */
  buildContext(text: string): Promise<GuardrailContext>;
  /** Runs after the em dash clean-up and before the guardrails (healthcare: add the fixed privacy line). */
  finalize?(text: string): string;
  /**
   * A hard length limit in characters (code points). Over it, the model is asked once more with a stricter
   * instruction; still over, the text is cut at a sentence boundary. Text over the limit is never returned.
   */
  maxChars?: number;
};

export type DraftRunResult = DraftResult & {
  /** Model calls made: 2 when the first answer was over `maxChars`. */
  attempts: number;
  /** The text was cut to fit `maxChars` after the retry. */
  truncated: boolean;
};

const chars = (s: string) => Array.from(s).length;

/**
 * Cut `text` to at most `max` characters, at the last sentence end that fits; failing that at the last
 * word; failing that hard. Never returns more than `max`.
 */
export function truncateToLimit(text: string, max: number): string {
  if (chars(text) <= max) return text;
  const head = Array.from(text).slice(0, max).join("");
  const sentence = /^[\s\S]*[.!?](?=\s|$)/.exec(head);
  if (sentence && chars(sentence[0]) >= max * 0.3) return sentence[0].trim();
  const word = head.replace(/\s+\S*$/, "").trimEnd();
  return word.length > 0 ? word : head.trimEnd();
}

/**
 * One metered, capped, guardrail-checked, audited model call. The cap check and the usage row happen
 * under the platform budget lock, so a bulk run (many calls in one transaction) stays sequential.
 * Throws AccessError FORBIDDEN "AI_BUDGET_EXCEEDED: ..." before the model is called when a cap would be
 * passed. Prompts and drafts are never logged or audited: ids, lengths, model and cost only.
 */
export async function runDraft(
  { tx, actor, audit }: { tx: Tx; actor: Actor; audit(entry: ActionAuditEntry): Promise<void> },
  p: DraftRun,
): Promise<DraftRunResult> {
  const env = aiEnv();
  const model = getAiModel(env);
  if (!model) throw new CoreError("NOT_CONFIGURED", AI_NOT_SET_UP);
  await assertAiEnabled(tx, actor.orgId);
  const modelId = AI_DEFAULTS.model;

  // One call at a time platform-wide while the caps are checked and the usage rows are written.
  await lockAiBudget(tx);

  /** One capped, metered model call. The cap is checked again before a retry. */
  async function callOnce(system: string) {
    const now = new Date();
    const worst = estimateMaxCostMicroUsd(
      modelId,
      system.length + p.user.length,
      AI_DEFAULTS.maxOutputTokens,
    );
    if ((await platformSpentMicroUsd(tx, now)) + worst > (await effectiveCapMicroUsd(tx, env))) {
      throw new AccessError("FORBIDDEN", "AI_BUDGET_EXCEEDED: the platform's monthly AI limit is reached");
    }
    const clientCap = await workspaceCapMicroUsd(tx, p.workspaceId);
    if (
      clientCap !== null &&
      (await workspaceSpentMicroUsd(tx, p.workspaceId, now)) + worst > clientCap
    ) {
      throw new AccessError("FORBIDDEN", "AI_BUDGET_EXCEEDED: this client's monthly AI limit is reached");
    }
    // Hosted billing: the account must cover the worst case plus markup. Lock order: platform budget (held), then this org.
    await assertCredit(tx, actor.orgId, withMarkupMicro(worst), now, env);
    const res = await model!({
      model: modelId,
      system,
      user: p.user,
      maxTokens: AI_DEFAULTS.maxOutputTokens,
    });
    // Metered the moment the model answers, so a blocked draft is still counted.
    const cost = costMicroUsd(modelId, res.inputTokens, res.outputTokens);
    const [usage] = await tx
      .insert(aiUsage)
      .values({
        orgId: actor.orgId,
        workspaceId: p.workspaceId,
        userId: actor.userId,
        action: "ai.draftText",
        purpose: p.purpose,
        model: modelId,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        costMicroUsd: cost,
      })
      .returning({ id: aiUsage.id });
    // ai_usage keeps the raw cost (the platform cap reads it); the account is charged cost plus markup, once.
    const charged = await debit(tx, { orgId: actor.orgId, reason: "ai", refId: usage!.id, microUsd: withMarkupMicro(cost), now, env });
    if (charged.shortfallMicro > 0) console.error(`[billing] ai shortfall org=${actor.orgId} usage=${usage!.id} micro=${charged.shortfallMicro}`);
    return { res, cost, usageId: usage!.id };
  }

  const prepare = (raw: string) => {
    const cleaned = cleanEmDashes(raw);
    return p.finalize ? p.finalize(cleaned) : cleaned;
  };

  const first = await callOnce(p.system);
  let res = first.res;
  let cost = first.cost;
  let usageId = first.usageId;
  let inputTokens = res.inputTokens;
  let outputTokens = res.outputTokens;
  let attempts = 1;
  let truncated = false;
  let text = prepare(res.text);
  if (p.maxChars !== undefined && chars(text) > p.maxChars) {
    const target = Math.floor(p.maxChars * 0.8);
    const second = await callOnce(
      `${p.system}\nYour last answer was ${chars(text)} characters. The hard limit is ${p.maxChars}. Write a shorter text of at most ${target} characters.`,
    );
    attempts = 2;
    res = second.res;
    cost += second.cost;
    usageId = second.usageId;
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    text = prepare(res.text);
    if (chars(text) > p.maxChars) {
      text = truncateToLimit(text, p.maxChars);
      truncated = true;
    }
  }

  // The text above was cleaned first, so what the guardrails check is exactly what a person would get.
  const result = runGuardrails(await p.buildContext(text));
  const blockedRuleIds = [
    ...new Set(result.violations.filter((v) => v.severity === "block").map((v) => v.ruleId)),
  ];
  const warningRuleIds = [
    ...new Set(result.violations.filter((v) => v.severity === "warn").map((v) => v.ruleId)),
  ];
  const status = result.ok ? ("ok" as const) : ("blocked" as const);

  await audit({
    action: "ai.draft",
    entityType: "ai_usage",
    entityId: usageId,
    after: {
      workspaceId: p.workspaceId,
      purpose: p.purpose,
      model: modelId,
      sourceChars: p.sourceChars,
      draftChars: text.length,
      inputTokens,
      outputTokens,
      costMicroUsd: cost,
      attempts,
      truncated,
      status,
      blockedRuleIds,
      warningRuleIds,
    },
  });

  return {
    status,
    draft: result.ok ? text : null,
    blockedRuleIds,
    warningRuleIds,
    model: modelId,
    inputTokens,
    outputTokens,
    costMicroUsd: cost,
    attempts,
    truncated,
  };
}
