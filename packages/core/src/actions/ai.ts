import { effectiveCapMicroUsd } from "../limits/ai-cap";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  aiUsage,
  locations,
  workspaceAiSettings,
  workspaces,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, type Actor } from "../actor";
import { AI_DEFAULTS } from "../config/ai-models";
import { isPlatformAdmin } from "../config/platform-admin";
import { marketForTimeZone } from "../config/writing-style";
import { type GuardrailContext } from "../guardrails";
import { guardWorkspace, recentLocationReplies } from "../reviews/reply-context";
import { getWorkspaceReplySettings } from "../reviews/workspace-settings";
import { aiEnv, getAiModel } from "../ai/model";
import { draftOut, runDraft } from "../ai/draft";
import {
  microToUsd,
  usdToMicro,
  utcMonthStart,
} from "../ai/money";
import { platformSpentMicroUsd, workspaceCapMicroUsd } from "../ai/usage";
import { buildSystemPrompt, DRAFT_PURPOSES, getBrandVoice, type BrandVoice } from "../ai/voice";
import { defineAction } from "../registry";
import { workspaceTimeZone } from "./posts";

async function requireWorkspace(tx: Tx, actor: Actor, workspaceId: string) {
  const [w] = await tx
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.orgId, actor.orgId)));
  if (!w) throw new AccessError("NOT_FOUND", "Workspace not found");
  return w;
}

// --- ai.draftText -----------------------------------------------------------------------------

export const aiDraftText = defineAction({
  name: "ai.draftText",
  description:
    "Draft text with AI for a client. purpose 'reply' (a reply to a review: sourceText is the review text; optional rating and reviewerName) or 'post' (a Google post: sourceText is the topic). The draft uses the client's brand voice (tone, banned words, sign-off, language), is metered (tokens, model, cost), and then runs through the same guardrails as replies and posts for the client's profile. status 'ok' returns the draft (warningRuleIds lists non-blocking findings); status 'blocked' returns blockedRuleIds and NO text. The call is refused before it is made when it would exceed the platform's or the client's monthly AI limit, and fails with NOT_CONFIGURED when this server has no AI key. A draft is only a proposal: it still goes through approval. Needs review:draft (owner, admin, manager).",
  input: z.object({
    workspaceId: z.uuid(),
    purpose: z.enum(DRAFT_PURPOSES),
    sourceText: z.string().trim().min(1).max(AI_DEFAULTS.maxSourceChars),
    rating: z.number().int().min(1).max(5).optional(),
    reviewerName: z.string().trim().max(200).optional(),
    locationId: z.uuid().optional(),
    /** A language the caller knows (name or code); the client's brand voice language wins over it. */
    language: z.string().trim().max(40).optional(),
  }),
  output: draftOut,
  permission: "review:draft",
  kind: "write",
  // Drafting only proposes text that then goes through approval, so MCP calls run directly.
  approval: "own_flow",
  async preview(_ctx, input) {
    return {
      summary: `Draft a ${input.purpose} with AI for this client (${input.sourceText.length} characters of source text). Nothing is published.`,
    };
  },
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:draft", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);

    let location = { name: "", phone: null as string | null };
    let recentReplies: string[] = [];
    if (input.locationId) {
      const [l] = await tx
        .select({ name: locations.name, title: locations.title, phone: locations.phone })
        .from(locations)
        .where(
          and(eq(locations.id, input.locationId), eq(locations.workspaceId, input.workspaceId)),
        );
      if (!l) throw new AccessError("NOT_FOUND", "Location not found");
      location = { name: l.title ?? l.name, phone: l.phone };
      recentReplies = await recentLocationReplies(tx, input.locationId);
    }

    const voice = await getBrandVoice(tx, input.workspaceId);
    const settings = await getWorkspaceReplySettings(tx, input.workspaceId);
    const market = marketForTimeZone(await workspaceTimeZone(tx, input.workspaceId));
    const system = buildSystemPrompt(input.purpose, voice, {
      market,
      rating: input.rating ?? null,
      ...(input.language ? { language: input.language } : {}),
    });
    const user = `<source>\n${input.sourceText}\n</source>`;

    const base = {
      location,
      workspace: guardWorkspace(settings),
      recentReplies,
    };
    const buildContext = async (text: string): Promise<GuardrailContext> =>
      input.purpose === "reply"
        ? {
            ...base,
            reply: text,
            contentType: "reply",
            review: {
              rating: (input.rating ?? null) as 1 | 2 | 3 | 4 | 5 | null,
              text: input.sourceText,
              reviewerDisplayName: input.reviewerName ?? null,
            },
          }
        : {
            ...base,
            reply: text,
            contentType: "post",
            post: { topicType: "STANDARD", alertType: null, cta: null, event: null, offer: null, media: [] },
            review: { rating: null, text: null, reviewerDisplayName: null },
          };
    return runDraft(
      { tx, actor, audit },
      {
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        system,
        user,
        sourceChars: input.sourceText.length,
        buildContext,
      },
    );
  },
});

// --- brand voice -------------------------------------------------------------------------------

const voiceOut = z.object({
  workspaceId: z.string(),
  tone: z.string(),
  bannedWords: z.array(z.string()),
  signOff: z.string(),
  language: z.string(),
});

const toVoiceOut = (workspaceId: string, v: BrandVoice): z.input<typeof voiceOut> => ({
  workspaceId,
  ...v,
});

export const aiVoiceGet = defineAction({
  name: "aiVoice.get",
  description:
    "A client's AI brand voice: tone, bannedWords, signOff and language (empty language = the language of the source text). A client that was never set up returns empty values. Needs review:read.",
  input: z.object({ workspaceId: z.uuid() }),
  output: voiceOut,
  permission: "review:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    authorize(actor, "review:read", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);
    return toVoiceOut(input.workspaceId, await getBrandVoice(tx, input.workspaceId));
  },
});

export const aiVoiceUpdate = defineAction({
  name: "aiVoice.update",
  description:
    "Set a client's AI brand voice; only the fields you pass change. tone: up to 200 characters (for example 'warm, plain, no jargon'). bannedWords: up to 50 words or phrases the drafts must not use. signOff: up to 200 characters, added at the end of every draft. language: up to 40 characters, a language name or code; empty means the language of the source text. These feed the AI prompt; the guardrails still check every output. Needs review:draft (owner, admin, manager).",
  input: z.object({
    workspaceId: z.uuid(),
    tone: z.string().trim().max(200).optional(),
    bannedWords: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    signOff: z.string().trim().max(200).optional(),
    language: z.string().trim().max(40).optional(),
  }),
  output: voiceOut,
  permission: "review:draft",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:draft", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);
    const before = await getBrandVoice(tx, input.workspaceId);
    const next: BrandVoice = {
      tone: input.tone ?? before.tone,
      bannedWords: input.bannedWords ? [...new Set(input.bannedWords)] : before.bannedWords,
      signOff: input.signOff ?? before.signOff,
      language: input.language ?? before.language,
    };
    const values = { ...next, updatedAt: new Date(), updatedBy: actor.userId };
    await tx
      .insert(workspaceAiSettings)
      .values({ workspaceId: input.workspaceId, orgId: actor.orgId, ...values })
      .onConflictDoUpdate({ target: workspaceAiSettings.workspaceId, set: values });
    await audit({
      action: "ai_voice.update",
      entityType: "workspace_ai_settings",
      entityId: input.workspaceId,
      // Lengths and counts only; the voice text is the client's own wording but is kept out of the log.
      before: { toneChars: before.tone.length, bannedWords: before.bannedWords.length, signOffChars: before.signOff.length, language: before.language },
      after: { toneChars: next.tone.length, bannedWords: next.bannedWords.length, signOffChars: next.signOff.length, language: next.language },
    });
    return toVoiceOut(input.workspaceId, next);
  },
});

// --- caps and usage ----------------------------------------------------------------------------

export const aiClientCapSet = defineAction({
  name: "aiUsage.setClientCap",
  description:
    "Set (or clear with null) one client's monthly AI spend cap in USD. A draft that would take the client over it is refused before the model is called. The platform-wide cap (AI_MONTHLY_BUDGET_USD) applies on top. The month is the UTC calendar month. Needs review:configure (owner, admin).",
  input: z.object({
    workspaceId: z.uuid(),
    monthlyCapUsd: z.number().min(0).max(100_000).nullable(),
  }),
  output: z.object({ workspaceId: z.string(), monthlyCapUsd: z.number().nullable() }),
  permission: "review:configure",
  kind: "write",
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "review:configure", { workspaceId: input.workspaceId });
    await requireWorkspace(tx, actor, input.workspaceId);
    const before = await workspaceCapMicroUsd(tx, input.workspaceId);
    const cap = input.monthlyCapUsd === null ? null : usdToMicro(input.monthlyCapUsd);
    const values = { monthlyCapMicroUsd: cap, updatedAt: new Date(), updatedBy: actor.userId };
    await tx
      .insert(workspaceAiSettings)
      .values({ workspaceId: input.workspaceId, orgId: actor.orgId, ...values })
      .onConflictDoUpdate({ target: workspaceAiSettings.workspaceId, set: values });
    await audit({
      action: "ai_cap.update",
      entityType: "workspace_ai_settings",
      entityId: input.workspaceId,
      before: { monthlyCapMicroUsd: before },
      after: { monthlyCapMicroUsd: cap },
    });
    return {
      workspaceId: input.workspaceId,
      monthlyCapUsd: cap === null ? null : microToUsd(cap),
    };
  },
});

export const aiUsageGet = defineAction({
  name: "aiUsage.get",
  description:
    "This month's (UTC) AI spend per client the caller can see, with each client's cap (null = none), and whether AI is set up on this server. platform (spend and cap across all organizations) is returned only to platform admins, otherwise null. Needs review:configure (owner, admin).",
  input: z.object({}),
  output: z.object({
    month: z.string(),
    aiOn: z.boolean(),
    clients: z.array(
      z.object({
        workspaceId: z.string(),
        name: z.string(),
        spentUsd: z.number(),
        capUsd: z.number().nullable(),
        calls: z.number().int(),
      }),
    ),
    platform: z.object({ spentUsd: z.number(), capUsd: z.number() }).nullable(),
  }),
  permission: "review:configure",
  kind: "read",
  async handler({ tx, actor }) {
    const now = new Date();
    const start = utcMonthStart(now);
    const ws = await tx
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(
        actor.workspaceIds === "all"
          ? eq(workspaces.orgId, actor.orgId)
          : and(eq(workspaces.orgId, actor.orgId), inArray(workspaces.id, actor.workspaceIds)),
      );
    const spent = new Map(
      (
        await tx
          .select({
            id: aiUsage.workspaceId,
            s: sql<string>`coalesce(sum(${aiUsage.costMicroUsd}), 0)`,
            n: sql<string>`count(*)`,
          })
          .from(aiUsage)
          .where(and(eq(aiUsage.orgId, actor.orgId), gte(aiUsage.createdAt, start)))
          .groupBy(aiUsage.workspaceId)
      ).map((r) => [r.id, { s: Number(r.s), n: Number(r.n) }]),
    );
    const caps = new Map(
      (
        await tx
          .select({ id: workspaceAiSettings.workspaceId, c: workspaceAiSettings.monthlyCapMicroUsd })
          .from(workspaceAiSettings)
          .where(eq(workspaceAiSettings.orgId, actor.orgId))
      ).map((r) => [r.id, r.c]),
    );
    const env = aiEnv();
    const platform = (await isPlatformAdmin(tx, actor.userId))
      ? {
          spentUsd: microToUsd(await platformSpentMicroUsd(tx, now)),
          capUsd: microToUsd(await effectiveCapMicroUsd(tx, env)),
        }
      : null;
    return {
      month: start.toISOString().slice(0, 7),
      aiOn: getAiModel(env) !== null,
      clients: ws
        .map((w) => ({
          workspaceId: w.id,
          name: w.name,
          spentUsd: microToUsd(spent.get(w.id)?.s ?? 0),
          capUsd: caps.get(w.id) == null ? null : microToUsd(caps.get(w.id)!),
          calls: spent.get(w.id)?.n ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      platform,
    };
  },
});
