import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { locations, type Tx } from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { PROFILE_LIMITS } from "../config/profile-limits";
import { marketForTimeZone } from "../config/writing-style";
import { CoreError } from "../errors";
import { draftOut, runDraft } from "../ai/draft";
import { keywordsIn } from "../ai/keywords";
import { buildSystemPrompt, getBrandVoice, type DraftPurpose } from "../ai/voice";
import type { GuardrailContext } from "../guardrails";
import { addMonths, lastCompleteMonth, monthsBetween } from "../performance/dates";
import { topKeywords } from "../performance/queries";
import { profileGuardrailContext } from "../profile/guardrails";
import { defineAction, type ActionContext } from "../registry";
import { workspaceTimeZone } from "./posts";

/** How many of the location's top search keywords go to the model, and over how many complete months. */
const KEYWORD_COUNT = 5;
const KEYWORD_MONTHS = 3;

const list = (max: number, each: number) => z.array(z.string().trim().min(1).max(each)).max(max);

const descriptionOut = draftOut.extend({
  /** The limit this draft was held to, in characters. */
  maxChars: z.number().int(),
  /** The model was asked a second time because the first answer was over the limit. */
  retried: z.boolean(),
  /** The text was cut at a sentence end to fit, after the retry was still too long. */
  truncated: z.boolean(),
  /** The location's top search keywords that were offered to the model (empty when none are stored). */
  keywordsConsidered: z.array(z.string()),
  /** Which of those the draft includes. A hint for the person; the draft is never forced to use them. */
  keywordsIncluded: z.array(z.string()),
});

/**
 * A location the actor may edit AND draft for. Roles with profile:edit (owner, admin, manager) also
 * hold review:draft today; both are checked so a future role with only one of them is refused.
 */
async function editableLocation(tx: Tx, actor: Actor, locationId: string) {
  const [loc] = await tx
    .select()
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.orgId, actor.orgId)));
  const scope = workspaceScope(actor);
  if (!loc || (scope !== "all" && !scope.includes(loc.workspaceId))) {
    throw new AccessError("NOT_FOUND", "Location not found");
  }
  authorize(actor, "profile:edit", { workspaceId: loc.workspaceId });
  authorize(actor, "review:draft", { workspaceId: loc.workspaceId });
  if (loc.status !== "active") throw new CoreError("CONFLICT", "Location is inactive");
  return loc;
}

async function draftDescription(
  ctx: ActionContext,
  loc: typeof locations.$inferSelect,
  p: {
    purpose: Extract<DraftPurpose, "description" | "service_description">;
    maxChars: number;
    facts: string[];
    keywords: string[];
    sourceChars: number;
    context(text: string): GuardrailContext;
  },
) {
  const { tx, actor, audit } = ctx;
  const voice = await getBrandVoice(tx, loc.workspaceId);
  const market = marketForTimeZone(await workspaceTimeZone(tx, loc.workspaceId));
  const system = buildSystemPrompt(p.purpose, voice, { market, maxChars: p.maxChars });
  const user = [
    "<source>",
    ...p.facts,
    ...(p.keywords.length > 0
      ? [
          `Search terms people use to find this business: ${p.keywords.join("; ")}`,
          "Use a search term only where it fits naturally in a sentence. Use each at most once. Never list them, and leave out any that do not fit.",
        ]
      : []),
    "</source>",
  ].join("\n");
  const r = await runDraft(
    { tx, actor, audit },
    {
      workspaceId: loc.workspaceId,
      purpose: p.purpose,
      system,
      user,
      sourceChars: p.sourceChars,
      maxChars: p.maxChars,
      async buildContext(text) {
        return p.context(text);
      },
    },
  );
  const { attempts, truncated, ...rest } = r;
  return {
    ...rest,
    maxChars: p.maxChars,
    retried: attempts > 1,
    truncated,
    keywordsConsidered: p.keywords,
    keywordsIncluded: r.draft ? keywordsIn(r.draft, p.keywords) : [],
  };
}

export const aiDraftBusinessDescription = defineAction({
  name: "ai.draftBusinessDescription",
  description:
    "Draft the business description for a location with AI. At most 750 characters (a longer answer is retried once, then cut at a sentence end), plain text, no links, in the client's brand voice and the writing style. The location's top Google search keywords from the stored Performance data are offered to the model as context; keywordsIncluded says which of them the draft happens to use (a hint, never forced). Optional facts the caller already has: categories, services and currentDescription (to improve it). status 'ok' returns the draft; status 'blocked' returns blockedRuleIds and NO text. The draft is only returned: nothing is saved, so it still goes through profile.preview, profile.propose and approval. Metered and capped like ai.draftText; the text sent to the model is never logged. Needs profile:edit and review:draft (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    categories: list(10, 200).optional(),
    services: list(40, 200).optional(),
    currentDescription: z.string().trim().max(PROFILE_LIMITS.descriptionMaxChars.limit * 4).optional(),
  }),
  output: descriptionOut,
  permission: "profile:edit",
  kind: "write",
  // Drafting only returns text that then goes through the profile change flow, so MCP calls run directly.
  approval: "own_flow",
  async preview() {
    return {
      summary: "Draft a business description with AI. Nothing is saved or published.",
    };
  },
  async handler(ctx, input) {
    const loc = await editableLocation(ctx.tx, ctx.actor, input.locationId);
    const end = lastCompleteMonth(new Date());
    const months = monthsBetween(addMonths(end, -(KEYWORD_MONTHS - 1)), end);
    const keywords = (
      await topKeywords(ctx.tx, { locationIds: [loc.id], months, limit: KEYWORD_COUNT })
    )
      .filter((k) => k.value > 0)
      .map((k) => k.keyword);
    const name = loc.title ?? loc.name;
    const facts = [
      `Business: ${name}`,
      ...(input.categories?.length ? [`Categories: ${input.categories.join(", ")}`] : []),
      ...(input.services?.length ? [`Services: ${input.services.join(", ")}`] : []),
      ...(input.currentDescription
        ? [`Current description (improve it, keep what is true):\n${input.currentDescription}`]
        : []),
    ];
    return draftDescription(ctx, loc, {
      purpose: "description",
      maxChars: PROFILE_LIMITS.descriptionMaxChars.limit,
      facts,
      keywords,
      sourceChars: facts.join("\n").length,
      // The context profile.preview builds for this field, so the draft meets what preview will check.
      context: (text) =>
        profileGuardrailContext({ fields: { description: text }, attributes: {} }, { name, phone: loc.phone }),
    });
  },
});

export const aiDraftServiceDescription = defineAction({
  name: "ai.draftServiceDescription",
  description:
    "Draft the description of one service for a location with AI. At most 1000 characters (a longer answer is retried once, then cut at a sentence end), plain text, no links, in the client's brand voice and the writing style. serviceName is required; categoryName and currentDescription are optional context. status 'ok' returns the draft; status 'blocked' returns blockedRuleIds and NO text. The draft is only returned: nothing is saved, so it still goes through profile.preview, profile.propose and approval. Metered and capped like ai.draftText; the text sent to the model is never logged. Needs profile:edit and review:draft (owner, admin, manager).",
  input: z.object({
    locationId: z.uuid(),
    serviceName: z.string().trim().min(1).max(500),
    categoryName: z.string().trim().max(200).optional(),
    currentDescription: z.string().trim().max(PROFILE_LIMITS.serviceDescriptionMaxChars.limit * 2).optional(),
  }),
  output: descriptionOut.pick({
    status: true,
    draft: true,
    blockedRuleIds: true,
    warningRuleIds: true,
    model: true,
    inputTokens: true,
    outputTokens: true,
    costMicroUsd: true,
    maxChars: true,
    retried: true,
    truncated: true,
  }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async preview() {
    return { summary: "Draft a service description with AI. Nothing is saved or published." };
  },
  async handler(ctx, input) {
    const loc = await editableLocation(ctx.tx, ctx.actor, input.locationId);
    const name = loc.title ?? loc.name;
    const facts = [
      `Business: ${name}`,
      `Service: ${input.serviceName}`,
      ...(input.categoryName ? [`Service category: ${input.categoryName}`] : []),
      ...(input.currentDescription
        ? [`Current description (improve it, keep what is true):\n${input.currentDescription}`]
        : []),
    ];
    const r = await draftDescription(ctx, loc, {
      purpose: "service_description",
      maxChars: PROFILE_LIMITS.serviceDescriptionMaxChars.limit,
      facts,
      keywords: [],
      sourceChars: facts.join("\n").length,
      // Universal rules (links, email, hashtags, offers, style) run on the text; the length is held by runDraft.
      context: (text) => ({
        ...profileGuardrailContext({ fields: {}, attributes: {} }, { name, phone: loc.phone }),
        reply: text,
      }),
    });
    // The output schema drops the keyword fields: a service draft is offered none.
    return r;
  },
});
