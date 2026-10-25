import { z } from "zod";
import type { Tx } from "@opengmb/db";
import { AccessError, type Actor } from "../actor";
import { AI_DEFAULTS } from "../config/ai-models";
import { POST_MAX_CHARS } from "../config/post-limits";
import { CoreError } from "../errors";
import { writeAudit } from "../audit";
import { AI_NOT_SET_UP, aiEnv, getAiModel } from "../ai/model";
import { draftOut, runDraft, type DraftResult } from "../ai/draft";
import { loadPostSource, postSourceText } from "../ai/postSource";
import { buildSystemPrompt, getBrandVoice } from "../ai/voice";
import type { PostContent } from "../posts/content";
import { buildPostGuardrailContext } from "../posts/context";
import { defineAction, type ActionContext } from "../registry";
import { authorizeWorkspace, insertDraft, postsSubmit } from "./posts";

/** A post is "short": a bit over a third of the 1,500 character limit, so the guardrail never has to cut it. */
const TARGET_CHARS = Math.round(POST_MAX_CHARS * 0.4);
const IDEA_COUNT = 5;
const IDEA_CHARS = 120;

const POST_TASK = `Write one Google Business Profile post for the business in the source, at most ${TARGET_CHARS} characters, in a few short sentences. Use the idea in the source if there is one; otherwise pick the best fit from the services, the general feedback theme and an upcoming occasion that is close. Mention the business name or the city once, naturally. End with a plain invitation to visit or get in touch, without a phone number or link.`;
const IDEAS_TASK = `Suggest exactly ${IDEA_COUNT} different ideas for short Google Business Profile posts for the business in the source. Draw on its services, the general feedback theme and the upcoming occasions. Give one idea per line, numbered 1 to ${IDEA_COUNT}, each at most ${IDEA_CHARS} characters, with no preface and no extra text.`;

/** Ways to open, one per location in a run, so the variants do not all start the same way. */
const OPENINGS = [
  "Open with a question to the reader.",
  "Open with the season or the occasion.",
  "Open with one of the services.",
  "Open with a short, plain statement about the place.",
  "Open with a thank-you to local customers.",
];

const STANDARD = (summary: string): PostContent => ({
  topicType: "STANDARD",
  alertType: null,
  summary,
  cta: null,
  event: null,
  offer: null,
  media: [],
});

/** The first words of a draft, to tell the next location not to start the same way. */
const opening = (text: string) => text.trim().split(/\s+/).slice(0, 5).join(" ");

async function draftPostText(
  ctx: { tx: Tx; actor: Actor; audit: ActionContext["audit"] },
  p: {
    workspaceId: string;
    locationId: string;
    mode: "post" | "ideas";
    idea?: string | undefined;
    language?: string | undefined;
    openingHint?: string | undefined;
    avoid?: string[];
  },
): Promise<DraftResult> {
  const { tx, actor } = ctx;
  const src = await loadPostSource(tx, actor, p.workspaceId, p.locationId);
  if (!src) throw new AccessError("NOT_FOUND", "Location not found");
  const voice = await getBrandVoice(tx, p.workspaceId);
  const system = buildSystemPrompt("post", voice, {
    market: src.market,
    task: p.mode === "ideas" ? IDEAS_TASK : POST_TASK,
    ...(p.language ? { language: p.language } : {}),
  });
  const extra = [
    ...(p.idea ? [`Idea: ${p.idea}`] : []),
    ...(p.openingHint ? [p.openingHint] : []),
    ...(p.avoid?.length ? [`Do not start like these other locations' posts: ${p.avoid.map((a) => `"${a}"`).join(", ")}`] : []),
  ];
  const user = postSourceText(src, extra);
  return runDraft(ctx, {
    workspaceId: p.workspaceId,
    purpose: "post",
    system,
    user,
    sourceChars: user.length,
    // The same context posts.submit uses for this location, so a warning here is the warning approval shows.
    async buildContext(text) {
      const c = await buildPostGuardrailContext(tx, {
        workspaceId: p.workspaceId,
        locationId: p.locationId,
        content: STANDARD(text),
      });
      if (!c) throw new AccessError("NOT_FOUND", "Location not found");
      return c;
    },
  });
}

const requireModel = () => {
  if (!getAiModel(aiEnv())) throw new CoreError("NOT_CONFIGURED", AI_NOT_SET_UP);
};

/** The ideas out of the model's numbered list. */
export function parseIdeas(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+\s*[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l !== "")
    .slice(0, IDEA_COUNT);
}

// --- ai.postIdeas ----------------------------------------------------------------------------------

export const aiPostIdeas = defineAction({
  name: "ai.postIdeas",
  description: `Suggest ${IDEA_COUNT} short Google post ideas for one location with AI, drawn from its services, a general theme of its recent positive reviews (never a quote or a reviewer's name; none at all for healthcare clients) and the occasions coming up in the next 60 days for the client's market (US, AU or IN, from the client's time zone). One AI call, metered and audited like ai.draftText. status 'ok' returns ideas; status 'blocked' returns blockedRuleIds and no ideas. Pick one, then call ai.draftPost with it. Refused with AI_BUDGET_EXCEEDED over the monthly cap, NOT_CONFIGURED when this server has no AI key. Nothing is saved. Needs review:draft (owner, admin, manager).`,
  input: z.object({
    workspaceId: z.uuid(),
    locationId: z.uuid(),
    language: z.string().trim().max(40).optional(),
  }),
  output: draftOut.omit({ draft: true }).extend({ ideas: z.array(z.string()) }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview() {
    return { summary: `Suggest ${IDEA_COUNT} post ideas with AI. Nothing is saved or published.` };
  },
  async handler({ tx, actor, audit }, input) {
    await authorizeWorkspace(tx, actor, input.workspaceId, "review:draft");
    requireModel();
    const { draft, ...rest } = await draftPostText(
      { tx, actor, audit },
      { workspaceId: input.workspaceId, locationId: input.locationId, mode: "ideas", language: input.language },
    );
    return { ...rest, ideas: draft === null ? [] : parseIdeas(draft) };
  },
});

// --- ai.draftPost ----------------------------------------------------------------------------------

export const aiDraftPost = defineAction({
  name: "ai.draftPost",
  description: `Write one Standard Google post for one location with AI, ready to drop into the composer. idea (optional, up to 300 characters) is one of the ai.postIdeas lines; without it the AI picks from the location's services, a general theme of its recent positive reviews and the next 60 days of occasions. Aims at about ${TARGET_CHARS} characters (the post limit is ${POST_MAX_CHARS}). Metered, em dashes removed, and run through the post guardrails for that location. status 'ok' returns the text (warningRuleIds lists non-blocking findings such as banned wording); status 'blocked' returns blockedRuleIds and NO text. Nothing is saved: put the text in posts.createDraft, then posts.submit. Needs review:draft (owner, admin, manager).`,
  input: z.object({
    workspaceId: z.uuid(),
    locationId: z.uuid(),
    idea: z.string().trim().min(1).max(300).optional(),
    language: z.string().trim().max(40).optional(),
  }),
  output: draftOut,
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview() {
    return { summary: "Write a post with AI. Nothing is saved or published." };
  },
  async handler({ tx, actor, audit }, input) {
    await authorizeWorkspace(tx, actor, input.workspaceId, "review:draft");
    requireModel();
    return draftPostText(
      { tx, actor, audit },
      { workspaceId: input.workspaceId, locationId: input.locationId, mode: "post", idea: input.idea, language: input.language },
    );
  },
});

// --- ai.draftPostVariants --------------------------------------------------------------------------

const OUTCOMES = ["drafted", "blocked", "refused", "skipped", "failed", "not_attempted"] as const;
const itemOut = z.object({
  locationId: z.string(),
  /**
   * drafted: a draft post for this location was saved and submitted for approval. blocked: a guardrail
   * blocked the text, nothing saved. refused: over the monthly cap, the run stopped here. skipped: the
   * location is not an active location of this client. failed: the AI call or the save failed (reason).
   * not_attempted: left untouched because the run stopped at a refusal.
   */
  outcome: z.enum(OUTCOMES),
  postId: z.string().nullable(),
  postStatus: z.string().nullable(),
  reason: z.string().nullable(),
  blockedRuleIds: z.array(z.string()),
  warningRuleIds: z.array(z.string()),
});
type Item = z.input<typeof itemOut>;

export const aiDraftPostVariants = defineAction({
  name: "ai.draftPostVariants",
  description: `Write a different Standard post for each of up to ${AI_DEFAULTS.bulkDraftMax} locations of one client with AI and put each into the approval queue as its own post (one location per post). One AI call per location, one after another, each committed on its own: a failure on one location never undoes the others. Each text names the location or its city and opens differently from the posts already written in the run. idea is optional (see ai.draftPost). For each location: drafted (saved and submitted; postStatus pending_approval, with any warnings stored on the post for the approver to read), blocked (a guardrail blocked the text; nothing saved), refused (over the monthly cap: the run stops there and the rest are not_attempted), skipped (not an active location of this client), failed (the AI call or the save failed). Posts always need a person to approve them; nothing is scheduled or sent. Same metering, guardrails and audit as ai.draftPost. NOT_CONFIGURED when this server has no AI key. Needs review:draft (owner, admin, manager).`,
  input: z.object({
    workspaceId: z.uuid(),
    locationIds: z.array(z.uuid()).min(1).max(AI_DEFAULTS.bulkDraftMax),
    idea: z.string().trim().min(1).max(300).optional(),
    language: z.string().trim().max(40).optional(),
  }),
  output: z.object({
    results: z.array(itemOut),
    counts: z.object({
      drafted: z.number().int(),
      blocked: z.number().int(),
      refused: z.number().int(),
      skipped: z.number().int(),
      failed: z.number().int(),
      notAttempted: z.number().int(),
    }),
    /** True when a monthly cap stopped the run before the last location. */
    stoppedOverCap: z.boolean(),
  }),
  permission: "review:draft",
  kind: "write",
  approval: "own_flow",
  async preview(_ctx, input) {
    return {
      summary: `Write a post with AI for each of ${input.locationIds.length} locations and submit them for approval. Nothing is published.`,
    };
  },
  async handler(ctx, input) {
    const { tx, actor, audit } = ctx;
    await authorizeWorkspace(tx, actor, input.workspaceId, "review:draft");
    requireModel();
    const ids = [...new Set(input.locationIds)];
    const results: Item[] = [];
    const item = (locationId: string, outcome: Item["outcome"], extra: Partial<Item> = {}): Item => ({
      locationId,
      outcome,
      postId: null,
      postStatus: null,
      reason: null,
      blockedRuleIds: [],
      warningRuleIds: [],
      ...extra,
    });
    let stopped: string | null = null;
    const written: string[] = [];

    for (const locationId of ids) {
      if (stopped) {
        results.push(item(locationId, "not_attempted", { reason: stopped }));
        continue;
      }
      // Each location is its own transaction on a separate connection (ctx.db), committed as soon as it
      // finishes (same pattern as ai.draftReplies): earlier drafts and their metering survive a later
      // failure, and the platform AI lock is held for one model call at a time.
      try {
        const out = await ctx.db.transaction(async (sp) => {
          const bind: ActionContext = {
            ...ctx,
            tx: sp,
            audit: async (entry) => {
              await writeAudit(sp, {
                ...entry,
                orgId: actor.orgId,
                actorUserId: actor.userId,
                actorType: actor.actorType,
                surface: actor.surface,
              });
            },
          };
          const d = await draftPostText(bind, {
            workspaceId: input.workspaceId,
            locationId,
            mode: "post",
            idea: input.idea,
            language: input.language,
            openingHint: OPENINGS[written.length % OPENINGS.length],
            avoid: written.slice(-6),
          }).catch((e) => {
            if (e instanceof AccessError && e.code === "NOT_FOUND") return null;
            throw e;
          });
          if (d === null) return item(locationId, "skipped", { reason: "Not an active location of this client." });
          if (d.status === "blocked") {
            return item(locationId, "blocked", {
              blockedRuleIds: d.blockedRuleIds,
              warningRuleIds: d.warningRuleIds,
              reason: "A guardrail blocked the text.",
            });
          }
          // The model call is already metered; a failure saving or submitting undoes only the post.
          try {
            return await sp.transaction(async (sp2) => {
              const save: ActionContext = { ...bind, tx: sp2 };
              const row = await insertDraft(save, {
                workspaceId: input.workspaceId,
                locationIds: [locationId],
                topicType: "STANDARD",
                summary: d.draft!,
              });
              // Posts never auto-approve, so warnings are stored for the approver to read, not held back.
              const sub = await postsSubmit.handler(save, { id: row.id, acknowledgeWarnings: true });
              if (sub.outcome === "blocked") throw new CoreError("CONFLICT", "The post could not be submitted (blocked).");
              written.push(opening(d.draft!));
              return item(locationId, "drafted", {
                postId: row.id,
                postStatus: sub.outcome,
                warningRuleIds: d.warningRuleIds,
              });
            });
          } catch (e) {
            if (e instanceof CoreError) return item(locationId, "failed", { reason: e.message });
            throw e;
          }
        });
        results.push(out);
      } catch (e) {
        if (e instanceof AccessError && e.message.startsWith("AI_BUDGET_EXCEEDED")) {
          stopped = "Stopped: a monthly AI limit was reached before this location.";
          results.push(item(locationId, "refused", { reason: e.message.replace("AI_BUDGET_EXCEEDED: ", "") }));
        } else {
          results.push(
            item(locationId, "failed", {
              reason: e instanceof CoreError ? e.message : "Something went wrong drafting this location.",
            }),
          );
        }
      }
    }

    const count = (o: Item["outcome"]) => results.filter((r) => r.outcome === o).length;
    const counts = {
      drafted: count("drafted"),
      blocked: count("blocked"),
      refused: count("refused"),
      skipped: count("skipped"),
      failed: count("failed"),
      notAttempted: count("not_attempted"),
    };
    // Counts only: never post text.
    await audit({
      action: "ai.draft_posts",
      entityType: "workspace",
      entityId: input.workspaceId,
      after: { requested: ids.length, ...counts },
    });
    return { results, counts, stoppedOverCap: count("refused") > 0 };
  },
});
