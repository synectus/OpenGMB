import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auditLog,
  performanceSnapshots,
  postTargets,
  posts,
  profileChangeSets,
  profileChangeTargets,
  profileChanges,
  reviewReplies,
  reviewSyncs,
  reviews,
  suspensionCases,
  users,
  workspaces,
  type Db,
} from "@opengmb/db";
import type { Actor } from "../actor";
import { scoreOf } from "../healthcheck/evaluate";
import { loadLocation, type LocRow } from "../locationOps/access";
import { clip, hoursOn, isOpenNow, zonedDay } from "../locations/overview";
import { OPEN_SUSPENSION_STATUSES, locationStats } from "../locations/stats";
import { googleOnlyPosts, lastPostDates } from "../posts/scope";
import { touchedNames, type ProfileValues } from "../profile/fields";
import { defineAction } from "../registry";
import { describeVoiceOfMerchant } from "../verification/state";
import { checksWithSkips, readHealthInputs } from "./healthcheck";

const ACTIVITY_MAX = 5;
const DAY_MS = 86_400_000;
const surfaceOut = z.string();

const out = z.object({
  location: z.object({
    id: z.string(),
    name: z.string(),
    workspaceId: z.string(),
    workspaceName: z.string(),
    addressSummary: z.string().nullable(),
    phone: z.string().nullable(),
    status: z.enum(["active", "inactive"]),
    needsRelink: z.boolean(),
  }),
  stats: z.object({
    reviews: z.object({ total: z.number(), avgRating: z.number().nullable(), unreplied: z.number(), waitingToPublish: z.number() }),
    openChanges: z.number(),
    suspensionOpen: z.boolean(),
  }),
  /** The latest post at this location, SynGMB-made or made on Google (posts/scope.ts); createdSurface is null for source google. */
  lastPost: z
    .object({
      publishedAt: z.string(),
      summary: z.string(),
      createdSurface: surfaceOut.nullable(),
      source: z.enum(["syngmb", "google"]),
    })
    .nullable(),
  changeSets: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["pending_approval", "approved"]),
      fieldNames: z.array(z.string()),
      locationCount: z.number(),
      createdSurface: surfaceOut,
      createdByName: z.string().nullable(),
      submittedAt: z.string().nullable(),
    }),
  ),
  suspension: z
    .object({
      id: z.string(),
      status: z.string(),
      openedAt: z.string(),
      evidenceDone: z.number(),
      evidenceTotal: z.number(),
    })
    .nullable(),
  syncs: z.object({
    reviewsPending: z.boolean(),
    lastReviewSyncAt: z.string().nullable(),
    /** A backfill was requested (audit performance.backfill_requested) and no snapshot exists yet. */
    performanceBackfillPending: z.boolean(),
  }),
  activity: z.array(z.object({ at: z.string(), text: z.string(), surface: surfaceOut.nullable() })),
  /** null when the location is inactive or not linked to Google: nothing was read. */
  google: z
    .object({
      checkedAt: z.string(),
      health: z.object({ passed: z.number(), total: z.number(), percent: z.number() }),
      /** Each part is null when its own Google read failed. */
      verification: z.object({ standing: z.string(), hasVoiceOfMerchant: z.boolean() }).nullable(),
      profile: z
        .object({
          primaryCategory: z.string().nullable(),
          /** Today's opening periods in the client's time zone, or null when closed today. */
          hoursToday: z.string().nullable(),
          /** Whether the regular hours say the location is open right now (client's zone); null when no hours are set. */
          openNow: z.boolean().nullable(),
          phone: z.string().nullable(),
          website: z.string().nullable(),
        })
        .nullable(),
      photos: z
        .object({
          count: z.number(),
          newestDays: z.number().nullable(),
          items: z.array(z.object({ category: z.string().nullable(), thumbnailUrl: z.string().nullable() })),
        })
        .nullable(),
      bookingLinks: z
        .array(z.object({ uri: z.string(), type: z.string(), preferred: z.boolean() }))
        .nullable(),
      lastPostAt: z.string().nullable(),
    })
    .nullable(),
});

async function readGoogle(db: Db, actor: Actor, loc: LocRow, timeZone: string) {
  const { input, now } = await readHealthInputs(db, actor, loc);
  const age = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS);
  };
  const l = input.location.ok ? input.location.value : null;
  const photos = input.media.ok
    ? input.media.value.filter((m) => !m.mediaFormat || m.mediaFormat === "PHOTO")
    : null;
  const ages = (photos ?? []).map((m) => age(m.createTime)).filter((a): a is number => a !== null);
  const livePosts = input.posts.ok
    ? input.posts.value.filter((p) => !p.state || p.state === "LIVE").map((p) => p.createTime).filter(Boolean)
    : [];
  return {
    checkedAt: now.toISOString(),
    health: scoreOf(await checksWithSkips(db, input, now)),
    verification: input.voice.ok
      ? (() => {
          const s = describeVoiceOfMerchant(input.voice.value);
          return { standing: s.standing, hasVoiceOfMerchant: s.hasVoiceOfMerchant };
        })()
      : null,
    profile: l
      ? {
          primaryCategory:
            l.categories?.primaryCategory?.displayName ?? l.categories?.primaryCategory?.name ?? null,
          hoursToday: hoursOn(l.regularHours?.periods ?? [], zonedDay(now, timeZone)),
          openNow: isOpenNow(l.regularHours?.periods ?? [], now, timeZone),
          phone: l.phoneNumbers?.primaryPhone ?? null,
          website: l.websiteUri ?? null,
        }
      : null,
    photos: photos
      ? {
          count: photos.length,
          newestDays: ages.length ? Math.min(...ages) : null,
          items: photos.slice(0, 4).map((m) => ({
            category: m.locationAssociation?.category ?? null,
            thumbnailUrl: m.thumbnailUrl ?? m.googleUrl ?? null,
          })),
        }
      : null,
    bookingLinks: input.links.ok
      ? input.links.value.map((k) => ({ uri: k.uri, type: k.placeActionType, preferred: k.isPreferred ?? false }))
      : null,
    lastPostAt: livePosts.length ? [...livePosts].sort().reverse()[0]! : null,
  };
}

async function activityFor(db: Db, orgId: string, locationId: string) {
  const changes = await db
    .select({ at: profileChanges.detectedAt, fieldPaths: profileChanges.fieldPaths, source: profileChanges.source, googleSuggested: profileChanges.googleSuggested })
    .from(profileChanges)
    .where(and(eq(profileChanges.orgId, orgId), eq(profileChanges.locationId, locationId)))
    .orderBy(desc(profileChanges.detectedAt))
    .limit(ACTIVITY_MAX);
  const sets = await db
    .select({
      at: profileChangeSets.submittedAt,
      fields: profileChangeSets.fields,
      status: profileChangeSets.status,
      surface: profileChangeSets.createdSurface,
      byName: users.name,
    })
    .from(profileChangeTargets)
    .innerJoin(profileChangeSets, eq(profileChangeSets.id, profileChangeTargets.changeSetId))
    .leftJoin(users, eq(users.id, profileChangeSets.createdBy))
    .where(
      and(
        eq(profileChangeTargets.orgId, orgId),
        eq(profileChangeTargets.locationId, locationId),
        isNotNull(profileChangeSets.submittedAt),
      ),
    )
    .orderBy(desc(profileChangeSets.submittedAt))
    .limit(ACTIVITY_MAX);
  const published = await db
    .select({ at: postTargets.publishedAt, summary: posts.summary, surface: posts.createdSurface })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(
      and(
        eq(postTargets.orgId, orgId),
        eq(postTargets.locationId, locationId),
        eq(postTargets.status, "published"),
        isNotNull(postTargets.publishedAt),
      ),
    )
    .orderBy(desc(postTargets.publishedAt))
    .limit(ACTIVITY_MAX);
  const replies = await db
    .select({ at: reviewReplies.publishedAt, rating: reviews.starRating, surface: reviewReplies.createdSurface })
    .from(reviewReplies)
    .innerJoin(reviews, eq(reviews.id, reviewReplies.reviewId))
    .where(
      and(
        eq(reviewReplies.orgId, orgId),
        eq(reviews.locationId, locationId),
        eq(reviewReplies.status, "published"),
        isNotNull(reviewReplies.publishedAt),
      ),
    )
    .orderBy(desc(reviewReplies.publishedAt))
    .limit(ACTIVITY_MAX);

  const items = [
    ...changes.map((c) => ({
      at: c.at,
      surface: null,
      text: c.googleSuggested
        ? `Google suggested an edit to ${c.fieldPaths.join(", ")}`
        : `${c.source === "nightly" ? "Nightly snapshot" : "A snapshot"} found a change to ${c.fieldPaths.join(", ")}`,
    })),
    ...sets.map((s) => ({
      at: s.at!,
      surface: s.surface,
      text: `${s.byName ?? "Someone"} proposed a profile change: ${touchedNames(s.fields as ProfileValues).join(", ")} (${s.status.replaceAll("_", " ")})`,
    })),
    ...published.map((p) => ({ at: p.at!, surface: p.surface, text: `Post published: ${clip(p.summary, 60)}` })),
    ...replies.map((r) => ({
      at: r.at!,
      surface: r.surface,
      text: `Reply published to ${r.rating === null ? "an unrated" : `a ${r.rating}★`} review`,
    })),
  ];
  return items
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, ACTIVITY_MAX)
    .map((i) => ({ at: i.at.toISOString(), text: i.text, surface: i.surface }));
}

export const locationsOverview = defineAction({
  name: "locations.overview",
  description:
    "One location's front page: its header facts (workspace, address, status, needsRelink), review/alert/suspension counts (as locations.stats), the last post OpenGMB published, change sets waiting for approval or apply that target it, the open suspension case with evidence progress, sync state, the 5 most recent events (changes found, change sets proposed, posts and replies published) and, for an active Google-linked location, one pass of the healthcheck's Google reads (about 7 calls, outside any transaction) giving the live health score, verification standing, primary category, today's hours and whether it is open now (both read in the workspace's time zone), phone, website, photos and booking links. Each Google part is null when its read failed; google is null for inactive or unlinked locations. Read only.",
  input: z.object({ locationId: z.uuid() }),
  output: out,
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const loc = await loadLocation(db, actor, input.locationId, "location:read");
    const [ws] = await db.select({ name: workspaces.name, timeZone: workspaces.timeZone }).from(workspaces).where(eq(workspaces.id, loc.workspaceId));
    const [stats] = await locationStats(db, actor.orgId, [loc.id]);

    const latest = (await lastPostDates(db, [loc.id])).get(loc.id);
    let lastPost: z.infer<typeof out>["lastPost"] = null;
    if (latest?.source === "google") {
      const [g] = await googleOnlyPosts(db, { orgId: actor.orgId, locationIds: [loc.id], limit: 1 });
      if (g) lastPost = { publishedAt: latest.at.toISOString(), summary: g.summary, createdSurface: null, source: "google" };
    } else if (latest) {
      const [m] = await db
        .select({ summary: posts.summary, createdSurface: posts.createdSurface })
        .from(postTargets)
        .innerJoin(posts, eq(posts.id, postTargets.postId))
        .where(
          and(
            eq(postTargets.orgId, actor.orgId),
            eq(postTargets.locationId, loc.id),
            eq(postTargets.status, "published"),
            eq(postTargets.publishedAt, latest.at),
          ),
        )
        .limit(1);
      if (m) lastPost = { publishedAt: latest.at.toISOString(), summary: m.summary, createdSurface: m.createdSurface, source: "syngmb" };
    }

    const sets = await db
      .select({
        id: profileChangeSets.id,
        status: profileChangeSets.status,
        fields: profileChangeSets.fields,
        createdSurface: profileChangeSets.createdSurface,
        createdByName: users.name,
        submittedAt: profileChangeSets.submittedAt,
      })
      .from(profileChangeTargets)
      .innerJoin(profileChangeSets, eq(profileChangeSets.id, profileChangeTargets.changeSetId))
      .leftJoin(users, eq(users.id, profileChangeSets.createdBy))
      .where(
        and(
          eq(profileChangeTargets.orgId, actor.orgId),
          eq(profileChangeTargets.locationId, loc.id),
          inArray(profileChangeSets.status, ["pending_approval", "approved"]),
        ),
      )
      .orderBy(asc(profileChangeSets.submittedAt), asc(profileChangeSets.id));
    const counts = sets.length
      ? await db
          .select({ id: profileChangeTargets.changeSetId, n: sql<number>`count(*)::int` })
          .from(profileChangeTargets)
          .where(inArray(profileChangeTargets.changeSetId, sets.map((s) => s.id)))
          .groupBy(profileChangeTargets.changeSetId)
      : [];

    const [kase] = await db
      .select()
      .from(suspensionCases)
      .where(
        and(
          eq(suspensionCases.orgId, actor.orgId),
          eq(suspensionCases.locationId, loc.id),
          inArray(suspensionCases.status, [...OPEN_SUSPENSION_STATUSES]),
        ),
      )
      .orderBy(desc(suspensionCases.openedAt))
      .limit(1);
    const evidence = (kase?.evidenceChecklist ?? []) as { done: boolean }[];

    const [pendingSync] = await db
      .select({ id: reviewSyncs.id })
      .from(reviewSyncs)
      .where(and(eq(reviewSyncs.locationId, loc.id), eq(reviewSyncs.status, "pending")))
      .limit(1);
    const [lastSync] = await db
      .select({ at: reviewSyncs.finishedAt })
      .from(reviewSyncs)
      .where(and(eq(reviewSyncs.locationId, loc.id), eq(reviewSyncs.status, "done"), isNotNull(reviewSyncs.finishedAt)))
      .orderBy(desc(reviewSyncs.finishedAt))
      .limit(1);
    const [snap] = await db
      .select({ id: performanceSnapshots.locationId })
      .from(performanceSnapshots)
      .where(eq(performanceSnapshots.locationId, loc.id));
    // Only a requested backfill counts as queued; a missing snapshot alone (old import, failed job,
    // the e2e seed) must not read as "queued" forever.
    const [requested] = snap
      ? []
      : await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.orgId, actor.orgId),
              eq(auditLog.entityType, "location"),
              eq(auditLog.entityId, loc.id),
              eq(auditLog.action, "performance.backfill_requested"),
            ),
          )
          .limit(1);

    const linked = loc.googleLocationId !== null && loc.connectionId !== null;
    return {
      location: {
        id: loc.id,
        name: loc.name,
        workspaceId: loc.workspaceId,
        workspaceName: ws?.name ?? "",
        addressSummary: loc.addressSummary,
        phone: loc.phone,
        status: loc.status,
        needsRelink: loc.connectionId === null && loc.googleLocationId !== null,
      },
      stats: stats!,
      lastPost,
      changeSets: sets.map((s) => ({
        id: s.id,
        status: s.status as "pending_approval" | "approved",
        fieldNames: touchedNames(s.fields as ProfileValues),
        locationCount: counts.find((c) => c.id === s.id)?.n ?? 1,
        createdSurface: s.createdSurface,
        createdByName: s.createdByName ?? null,
        submittedAt: s.submittedAt?.toISOString() ?? null,
      })),
      suspension: kase
        ? {
            id: kase.id,
            status: kase.status,
            openedAt: kase.openedAt.toISOString(),
            evidenceDone: evidence.filter((e) => e.done).length,
            evidenceTotal: evidence.length,
          }
        : null,
      syncs: {
        reviewsPending: Boolean(pendingSync),
        lastReviewSyncAt: lastSync?.at?.toISOString() ?? null,
        performanceBackfillPending: !snap && Boolean(requested),
      },
      activity: await activityFor(db, actor.orgId, loc.id),
      google: loc.status === "active" && linked ? await readGoogle(db, actor, loc, ws?.timeZone ?? "UTC") : null,
    };
  },
});
