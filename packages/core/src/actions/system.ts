import { and, desc, eq, inArray, max } from "drizzle-orm";
import { z } from "zod";
import { jobRuns, locations, performanceSnapshots, profileSnapshots, reviewSyncs } from "@opengmb/db";
import { roleHasPermission } from "../permissions";
import { defineAction } from "../registry";
import { SYSTEM_JOBS, SYSTEM_STATUS_LOCATION_CAP, jobView } from "../system-jobs";
import { locationScope } from "./locations";

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export const systemStatus = defineAction({
  name: "system.status",
  description:
    "Scheduled background jobs on this server (schedule in UTC, last run, result ok/failed/running/never, next run, late when two scheduled runs in a row were missed; error text for owners and admins only) and, for the locations you can see (sorted by name, up to 500), when reviews were last synced, the newest sync attempt and its reason code, the last performance snapshot date and when a profile change was last found. Never calls Google.",
  input: z.object({}),
  output: z.object({
    jobs: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        schedule: z.string(),
        lastRunAt: z.string().nullable(),
        result: z.enum(["never", "running", "ok", "failed"]),
        note: z.string().nullable(),
        error: z.string().nullable(),
        nextRunAt: z.string(),
        late: z.boolean(),
      }),
    ),
    locations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        workspaceId: z.string(),
        status: z.string(),
        needsRelink: z.boolean(),
        reviewsLastSyncedAt: z.string().nullable(),
        reviewsLastStatus: z.enum(["pending", "done", "failed"]).nullable(),
        reviewsLastError: z.string().nullable(),
        performanceDate: z.string().nullable(),
        profileLastChangedAt: z.string().nullable(),
      }),
    ),
    truncated: z.boolean(),
  }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }) {
    const now = new Date();
    const latest = await tx
      .selectDistinctOn([jobRuns.job])
      .from(jobRuns)
      .where(inArray(jobRuns.job, SYSTEM_JOBS.map((j) => j.key)))
      .orderBy(jobRuns.job, desc(jobRuns.startedAt), desc(jobRuns.id));
    const showErrors = roleHasPermission(actor.role, "google:manage");
    const jobs = SYSTEM_JOBS.map((j) => {
      const v = jobView(j.cron, latest.find((r) => r.job === j.key) ?? null, now);
      return { key: j.key, label: j.label, schedule: j.schedule, ...v, error: showErrors ? v.error : null };
    });

    const locs = await tx
      .select({
        id: locations.id,
        name: locations.name,
        workspaceId: locations.workspaceId,
        status: locations.status,
        connectionId: locations.connectionId,
        googleLocationId: locations.googleLocationId,
      })
      .from(locations)
      .where(locationScope(actor))
      .orderBy(locations.name, locations.id)
      .limit(SYSTEM_STATUS_LOCATION_CAP + 1);
    const shown = locs.slice(0, SYSTEM_STATUS_LOCATION_CAP);
    const ids = shown.map((l) => l.id);
    if (ids.length === 0) return { jobs, locations: [], truncated: false };

    const [newest, lastDone, perf, prof] = await Promise.all([
      tx
        .selectDistinctOn([reviewSyncs.locationId], {
          locationId: reviewSyncs.locationId,
          status: reviewSyncs.status,
          error: reviewSyncs.error,
        })
        .from(reviewSyncs)
        .where(inArray(reviewSyncs.locationId, ids))
        .orderBy(reviewSyncs.locationId, desc(reviewSyncs.createdAt)),
      tx
        .select({ locationId: reviewSyncs.locationId, at: max(reviewSyncs.finishedAt) })
        .from(reviewSyncs)
        .where(and(inArray(reviewSyncs.locationId, ids), eq(reviewSyncs.status, "done")))
        .groupBy(reviewSyncs.locationId),
      tx
        .select({ locationId: performanceSnapshots.locationId, date: performanceSnapshots.lastSnapshotDate })
        .from(performanceSnapshots)
        .where(inArray(performanceSnapshots.locationId, ids)),
      tx
        .select({ locationId: profileSnapshots.locationId, at: max(profileSnapshots.takenAt) })
        .from(profileSnapshots)
        .where(inArray(profileSnapshots.locationId, ids))
        .groupBy(profileSnapshots.locationId),
    ]);

    return {
      jobs,
      locations: shown.map((l) => {
        const n = newest.find((r) => r.locationId === l.id);
        return {
          id: l.id,
          name: l.name,
          workspaceId: l.workspaceId,
          status: l.status,
          needsRelink: l.connectionId === null && l.googleLocationId !== null,
          reviewsLastSyncedAt: iso(lastDone.find((r) => r.locationId === l.id)?.at),
          reviewsLastStatus: n?.status ?? null,
          reviewsLastError: n?.error ?? null,
          performanceDate: perf.find((r) => r.locationId === l.id)?.date ?? null,
          profileLastChangedAt: iso(prof.find((r) => r.locationId === l.id)?.at),
        };
      }),
      truncated: locs.length > SYSTEM_STATUS_LOCATION_CAP,
    };
  },
});
