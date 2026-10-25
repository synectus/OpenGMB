import { and, eq, inArray } from "drizzle-orm";
import { locations, postTargets, type Tx } from "@opengmb/db";
import {
  runGuardrails,
  type GuardrailContext,
  type GuardrailResult,
  type PackId,
} from "../guardrails";
import { getWorkspaceReplySettings } from "../reviews/workspace-settings";
import { fieldsOf, type PostContent } from "./content";

/**
 * The guardrail context for a post's `content` at one location (or, with `locationId` null, at no
 * particular location: used by `posts.check` before locations are chosen). Workspace settings come
 * only from `getWorkspaceReplySettings`. Reply-only inputs (review, recent replies) are empty.
 */
export async function buildPostGuardrailContext(
  tx: Tx,
  p: { workspaceId: string; locationId: string | null; content: PostContent },
): Promise<GuardrailContext | null> {
  let location = { name: "", phone: null as string | null };
  if (p.locationId) {
    const [row] = await tx
      .select({ name: locations.name, title: locations.title, phone: locations.phone })
      .from(locations)
      .where(and(eq(locations.id, p.locationId), eq(locations.workspaceId, p.workspaceId)));
    if (!row) return null;
    location = { name: row.title ?? row.name, phone: row.phone };
  }
  const settings = await getWorkspaceReplySettings(tx, p.workspaceId);
  return {
    contentType: "post",
    post: fieldsOf(p.content),
    reply: p.content.summary,
    review: { rating: null, text: null, reviewerDisplayName: null },
    location,
    workspace: {
      profile: settings.profile,
      packs: settings.packs as PackId[],
      skipPositiveReviews: settings.skipPositiveReviews,
      staffNames: settings.staffNames,
      ...(settings.h2Severity === "warn" ? { severityOverrides: { "H2.*": "warn" } } : {}),
    },
    recentReplies: [],
  };
}

/**
 * Guardrails for a post across every target location (their names, phones and the workspace's
 * settings can differ). ok only if every location is ok; violations are de-duplicated by rule and
 * message. This merged result is for storing and display; the per-location results run again at send.
 */
export async function checkPostAtLocations(
  tx: Tx,
  p: { workspaceId: string; locationIds: string[]; content: PostContent },
): Promise<GuardrailResult> {
  const results: GuardrailResult[] = [];
  const ids: (string | null)[] = p.locationIds.length > 0 ? p.locationIds : [null];
  for (const locationId of ids) {
    const ctx = await buildPostGuardrailContext(tx, { ...p, locationId });
    if (ctx) results.push(runGuardrails(ctx));
  }
  const seen = new Set<string>();
  const violations = results
    .flatMap((r) => r.violations)
    .filter((v) => {
      const k = `${v.ruleId}|${v.severity}|${v.message}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  return {
    ok: results.every((r) => r.ok),
    violations,
    packs: results[0]?.packs ?? ["universal", "post"],
  };
}

/** Pending targets of the post's current occurrence, with their location ids. */
export async function pendingLocationIds(
  tx: Tx,
  postId: string,
  occurrence: number,
): Promise<string[]> {
  const rows = await tx
    .select({ locationId: postTargets.locationId })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.postId, postId),
        eq(postTargets.occurrence, occurrence),
        inArray(postTargets.status, ["pending"]),
      ),
    );
  return rows.map((r) => r.locationId);
}
