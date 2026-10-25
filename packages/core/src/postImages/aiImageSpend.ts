import { effectiveCapMicroUsd } from "../limits/ai-cap";
import { assertAiEnabled } from "../ai/switch";
import { aiUsage, type Tx } from "@opengmb/db";
import { AccessError, type Actor } from "../actor";
import { aiEnv } from "../ai/model";
import { lockAiBudget, platformSpentMicroUsd, workspaceCapMicroUsd, workspaceSpentMicroUsd } from "../ai/usage";
import { assertCredit, debit, withMarkupMicro } from "../billing";
import { AI_IMAGES } from "../config/post-image-sources";
import { generateImage, type GeneratedImage } from "./providers";

/** What one AI image costs us, in micro-USD: the output-token estimate at the model's output rate, rounded up. */
export const aiImageCostMicroUsd = (): number =>
  Math.ceil((AI_IMAGES.estimatedOutputTokens * AI_IMAGES.imageOutputPerMTokMicroUsd) / 1_000_000);

/** What the account is charged: cost plus the one resale markup. This is the price shown before generating. */
export const aiImageChargeMicroUsd = (): number => withMarkupMicro(aiImageCostMicroUsd());

/**
 * One metered AI image, charged the way an AI draft is: platform and client monthly caps first, then the
 * account's credit, then the call, then an ai_usage row (raw cost, which the caps read) and a ledger debit
 * (cost plus markup). The price is flat, so the price shown equals the price charged. Prompt text is
 * never stored.
 */
export async function runImageGeneration(
  tx: Tx,
  actor: Actor,
  workspaceId: string,
  subject: string,
): Promise<{ image: GeneratedImage; usageId: string; costMicroUsd: number; chargedMicroUsd: number }> {
  const env = aiEnv();
  await assertAiEnabled(tx, actor.orgId);
  await lockAiBudget(tx);
  const now = new Date();
  const cost = aiImageCostMicroUsd();
  if ((await platformSpentMicroUsd(tx, now)) + cost > (await effectiveCapMicroUsd(tx, env))) {
    throw new AccessError("FORBIDDEN", "AI_BUDGET_EXCEEDED: the platform's monthly AI limit is reached");
  }
  const clientCap = await workspaceCapMicroUsd(tx, workspaceId);
  if (clientCap !== null && (await workspaceSpentMicroUsd(tx, workspaceId, now)) + cost > clientCap) {
    throw new AccessError("FORBIDDEN", "AI_BUDGET_EXCEEDED: this client's monthly AI limit is reached");
  }
  const charged = aiImageChargeMicroUsd();
  await assertCredit(tx, actor.orgId, charged, now, env);
  const image = await generateImage(subject);
  const [usage] = await tx
    .insert(aiUsage)
    .values({
      orgId: actor.orgId,
      workspaceId,
      userId: actor.userId,
      action: "postImages.generate",
      purpose: "post_image",
      model: AI_IMAGES.model,
      inputTokens: image.inputTokens ?? 0,
      outputTokens: image.outputTokens ?? AI_IMAGES.estimatedOutputTokens,
      costMicroUsd: cost,
    })
    .returning({ id: aiUsage.id });
  const res = await debit(tx, { orgId: actor.orgId, reason: "ai", refId: usage!.id, microUsd: charged, now, env });
  if (res.shortfallMicro > 0) console.error(`[billing] ai image shortfall org=${actor.orgId} usage=${usage!.id} micro=${res.shortfallMicro}`);
  return { image, usageId: usage!.id, costMicroUsd: cost, chargedMicroUsd: charged };
}
