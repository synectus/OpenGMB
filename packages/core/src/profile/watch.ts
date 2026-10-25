import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import {
  locations,
  notifications,
  profileChanges,
  profileChangeTargets,
  profileSnapshots,
  type Db,
  type Tx,
} from "@opengmb/db";
import { canonicalJson } from "../audit";
import { PROFILE_LIMITS } from "../config/profile-limits";
import type { GoogleClient } from "../google/client";
import { enqueueJob } from "../jobs";
import { orgStagger } from "../google/rate-limit-retry";
import { recipientsForLocation } from "../notifications";
import { clientFor } from "../reviews/reply-jobs";
import { sha256, workerAudit } from "../reviews/reply-state";
import { addressHash, tryEnqueueLocationCenter } from "../locations/center";
import { fetchProfile } from "./fetch";
import { eligibleFields, planAutoRevert, runAutoRevert } from "./autoRevert";
import {
  FIELD_MASK,
  PROFILE_FIELDS,
  same,
  snapshotFromGoogle,
  snapshotFromJson,
  type ProfileSnapshot,
  type ProfileValues,
} from "./fields";

export const PROFILE_SNAPSHOT_QUEUE = "profile.snapshot";
export const PROFILE_SNAPSHOT_SCHEDULE_QUEUE = "profile.snapshot_schedule";
export const PROFILE_WATCH_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;
export const PROFILE_CHANGED_KIND = "profile.changed";

export type ProfileSnapshotJob = { locationId: string; rlAttempt?: number };
export type WatchReader = Pick<GoogleClient, "getLocation" | "getAttributes" | "getVoiceOfMerchantState">;
export type WatchLocation = { id: string; orgId: string; name: string; title?: string | null };

export const snapshotHash = (s: ProfileSnapshot) => sha256(canonicalJson(s));

/** The fields and attributes whose normalised value differs, with both sides. */
export function diffSnapshots(
  prev: ProfileSnapshot,
  next: ProfileSnapshot,
): { fieldPaths: string[]; before: ProfileValues; after: ProfileValues } {
  const out = {
    fieldPaths: [] as string[],
    before: { fields: {}, attributes: {} } as ProfileValues,
    after: { fields: {}, attributes: {} } as ProfileValues,
  };
  for (const f of PROFILE_FIELDS) {
    const a = prev.fields[f] ?? null;
    const b = next.fields[f] ?? null;
    if (same(a, b)) continue;
    out.fieldPaths.push(f);
    out.before.fields[f] = a;
    out.after.fields[f] = b;
  }
  const names = [...new Set([...Object.keys(prev.attributes), ...Object.keys(next.attributes)])];
  for (const n of names.sort()) {
    const a = prev.attributes[n] ?? null;
    const b = next.attributes[n] ?? null;
    if (same(a, b)) continue;
    out.fieldPaths.push(n);
    out.before.attributes[n] = a;
    out.after.attributes[n] = b;
  }
  return out;
}

/**
 * A snapshot stored before a field joined PROFILE_FIELDS (storeCode and storefrontAddress, L5) has no
 * value for it, and normalises to null. Reporting "null -> the real value" as an outside edit would
 * alert every location once, so a field the stored snapshot never recorded is taken as unchanged.
 */
export function withoutNewFields(raw: unknown, prev: ProfileSnapshot, next: ProfileSnapshot): ProfileSnapshot {
  const stored = (raw as { fields?: Record<string, unknown> } | null)?.fields ?? {};
  const fields = { ...prev.fields };
  for (const f of PROFILE_FIELDS) if (!(f in stored)) fields[f] = next.fields[f] ?? null;
  return { ...prev, fields };
}

/** Queue one snapshot job per active, Google-linked location. Run nightly by the schedule queue. */
export async function enqueueNightlyProfileSnapshots(
  db: Db,
  /** Tests: limit the fan-out to one organization (the shared test database holds many). */
  scope: { orgId?: string } = {},
): Promise<{ enqueued: number }> {
  const rows = await db
    .select({ id: locations.id, orgId: locations.orgId })
    .from(locations)
    .where(
      and(
        eq(locations.status, "active"),
        scope.orgId ? eq(locations.orgId, scope.orgId) : undefined,
        isNotNull(locations.googleLocationId),
        isNotNull(locations.connectionId),
      ),
    );
  // One transaction: the fan-out is all-or-nothing and a thousand locations stay one round of commits.
  await db.transaction(async (tx) => {
    const stagger = orgStagger();
    for (const r of rows) await enqueueJob(tx, PROFILE_SNAPSHOT_QUEUE, { locationId: r.id }, { startAfterSeconds: stagger(r.orgId) });
  });
  return { enqueued: rows.length };
}

type Detected = {
  fieldPaths: string[];
  before: ProfileValues;
  after: ProfileValues;
  source: "nightly" | "push" | "manual";
  googleSuggested: boolean;
};

/**
 * One `profile_changes` row, an audit row and a `profile.changed` notification for every member who
 * can see the location. The notification title carries the location name only and the audit row
 * field NAMES: never a value (a profile can carry anything the business typed).
 * Returns the change id; `notified` is false when nobody can see the location.
 */
async function insertChange(
  tx: Tx,
  loc: WatchLocation,
  d: Detected,
): Promise<{ id: string; recipientCount: number }> {
  const [row] = await tx
    .insert(profileChanges)
    .values({
      orgId: loc.orgId,
      locationId: loc.id,
      source: d.source,
      fieldPaths: d.fieldPaths,
      before: d.before,
      after: d.after,
      googleSuggested: d.googleSuggested,
    })
    .returning();
  const recipients = await recipientsForLocation(tx, loc.orgId, loc.id);
  if (recipients.length > 0) {
    await tx
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          orgId: loc.orgId,
          userId,
          kind: PROFILE_CHANGED_KIND,
          title: `Profile change at ${loc.title || loc.name}`,
          link: `/locations/${loc.id}/changes`,
          sourceType: "profile_change",
          sourceId: row!.id,
        })),
      )
      .onConflictDoNothing({
        target: [notifications.userId, notifications.sourceType, notifications.sourceId],
      });
  }
  await workerAudit(
    tx,
    loc.orgId,
  )({
    action: "profile.change_detected",
    entityType: "profile_change",
    entityId: row!.id,
    after: {
      locationId: loc.id,
      source: d.source,
      googleSuggested: d.googleSuggested,
      fieldNames: d.fieldPaths,
      recipientCount: recipients.length,
    },
  });
  return { id: row!.id, recipientCount: recipients.length };
}

/**
 * Drop fields that this app itself just wrote: a value equal to the `after` of a target applied
 * since the previous snapshot is our own approved edit (or revert), not an outside change.
 */
async function withoutOwnWrites(
  tx: Tx,
  locationId: string,
  since: Date,
  d: ReturnType<typeof diffSnapshots>,
) {
  const ours = await tx
    .select({ after: profileChangeTargets.after })
    .from(profileChangeTargets)
    .where(
      and(
        eq(profileChangeTargets.locationId, locationId),
        eq(profileChangeTargets.status, "applied"),
        gt(profileChangeTargets.appliedAt, since),
      ),
    );
  const written = (part: "fields" | "attributes", key: string, value: unknown) =>
    ours.some((o) => {
      const a = (o.after as ProfileValues)[part] as Record<string, unknown>;
      return key in a && same(a[key], value);
    });
  const out = {
    fieldPaths: [] as string[],
    before: { fields: {}, attributes: {} } as ProfileValues,
    after: { fields: {}, attributes: {} } as ProfileValues,
  };
  for (const p of d.fieldPaths) {
    const part = p.startsWith("attributes/") ? "attributes" : "fields";
    const afterV = (d.after[part] as Record<string, unknown>)[p];
    if (written(part, p, afterV)) continue;
    out.fieldPaths.push(p);
    (out.before[part] as Record<string, unknown>)[p] = (d.before[part] as Record<string, unknown>)[
      p
    ];
    (out.after[part] as Record<string, unknown>)[p] = afterV;
  }
  return out;
}

export type SnapshotOutcome = "skipped" | "baseline" | "unchanged" | "changed" | "own_changes_only";

/**
 * Nightly (or manual) snapshot of one location's MERCHANT view. Google is read first, with no
 * transaction open; then one short transaction (serialised per location by an advisory lock) stores
 * a new snapshot only when its hash differs from the latest, and diffs against that latest. The
 * first snapshot is a baseline and raises nothing. Safe to re-run: an unchanged profile writes
 * nothing. Fields equal to what this app applied since the previous snapshot are not reported.
 */
export async function processProfileSnapshot(
  db: Db,
  job: ProfileSnapshotJob & { source?: "nightly" | "manual" },
  deps: { client?: WatchReader } = {},
): Promise<SnapshotOutcome> {
  const [loc] = await db.select().from(locations).where(eq(locations.id, job.locationId));
  if (!loc || loc.status !== "active" || !loc.googleLocationId) return "skipped";
  const client = deps.client ?? (await clientFor(db, loc.orgId, loc.connectionId));
  if (!client) return "skipped";
  const { snapshot } = await fetchProfile(client, loc.googleLocationId);
  const hash = snapshotHash(snapshot);
  const source = job.source ?? "nightly";
  // L8: read Google (standing) before the transaction; the change itself is undone after it commits.
  const autoPlan = await planAutoRevert(db, { id: loc.id, googleLocationId: loc.googleLocationId }, client);
  let toRevert: { changeId: string; fieldNames: string[] } | null = null;

  const outcome = await db.transaction(async (tx): Promise<SnapshotOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${loc.id}::text, 1))`);
    // Stored coordinates follow the address: look them up again only when the address differs from
    // the one they were resolved for. A location never resolved (no hash) is the backfill's job, and a
    // manual centre is never replaced (the job itself refuses it).
    const nowHash = addressHash(snapshot.fields.storefrontAddress);
    if (nowHash && loc.centerAddressHash && loc.centerAddressHash !== nowHash && loc.centerSource !== "manual") {
      await tryEnqueueLocationCenter(tx, { locationId: loc.id, reason: "address_changed" });
    }
    const [prev] = await tx
      .select()
      .from(profileSnapshots)
      .where(eq(profileSnapshots.locationId, loc.id))
      .orderBy(desc(profileSnapshots.takenAt), desc(profileSnapshots.id))
      .limit(1);
    if (prev && prev.hash === hash) return "unchanged";
    await tx.insert(profileSnapshots).values({
      orgId: loc.orgId,
      locationId: loc.id,
      source,
      data: snapshot,
      hash,
    });
    if (!prev) return "baseline";
    const diff = await withoutOwnWrites(
      tx,
      loc.id,
      prev.takenAt,
      diffSnapshots(withoutNewFields(prev.data, snapshotFromJson(prev.data), snapshot), snapshot),
    );
    if (diff.fieldPaths.length === 0) return "own_changes_only";
    // L8: the enabled name/phone/address fields that may be undone go into a change of their own, so
    // reverting it restores exactly those fields and leaves the rest of the diff to a person.
    const protectedPaths = autoPlan
      ? await eligibleFields(
          tx,
          loc.id,
          diff.fieldPaths
            .filter((p) => autoPlan.fields.has(p))
            .map((path) => ({ path, after: (diff.after.fields as Record<string, unknown>)[path] })),
          new Date(),
        )
      : new Set<string>();
    if (protectedPaths.size === 0) {
      await insertChange(tx, loc, { ...diff, source, googleSuggested: false });
      return "changed";
    }
    const rest = pickPaths(diff, (p) => !protectedPaths.has(p));
    const mine = pickPaths(diff, (p) => protectedPaths.has(p));
    if (rest.fieldPaths.length > 0) {
      await insertChange(tx, loc, { ...rest, source, googleSuggested: false });
    }
    const { id } = await insertChange(tx, loc, { ...mine, source, googleSuggested: false });
    toRevert = { changeId: id, fieldNames: mine.fieldPaths };
    return "changed";
  });
  const pending = toRevert as { changeId: string; fieldNames: string[] } | null;
  if (pending && autoPlan) {
    await runAutoRevert(db, {
      orgId: loc.orgId,
      locationId: loc.id,
      enabledBy: autoPlan.enabledBy,
      ...pending,
    });
  }
  return outcome;
}

/** The part of a diff whose paths satisfy `keep`. */
function pickPaths(d: ReturnType<typeof diffSnapshots>, keep: (path: string) => boolean) {
  const out = {
    fieldPaths: [] as string[],
    before: { fields: {}, attributes: {} } as ProfileValues,
    after: { fields: {}, attributes: {} } as ProfileValues,
  };
  for (const p of d.fieldPaths.filter(keep)) {
    const part = p.startsWith("attributes/") ? "attributes" : "fields";
    out.fieldPaths.push(p);
    (out.before[part] as Record<string, unknown>)[p] = (d.before[part] as Record<string, unknown>)[p];
    (out.after[part] as Record<string, unknown>)[p] = (d.after[part] as Record<string, unknown>)[p];
  }
  return out;
}

// ---------------------------------------------------------------------------
// GOOGLE_UPDATE push
// ---------------------------------------------------------------------------

export type GoogleSuggestion = {
  fieldPaths: string[];
  before: ProfileValues;
  after: ProfileValues;
};
export type SuggestionReader = WatchReader & Pick<GoogleClient, "getGoogleUpdated">;

/** `fm` (a FIELD_MASK entry) and the Google mask entry `m` name the same field or one contains the other. */
const covers = (fm: string, m: string) =>
  m === fm || m.startsWith(`${fm}.`) || fm.startsWith(`${m}.`);

/**
 * Phase 1 of a GOOGLE_UPDATE push (no transaction): ask Google what consumers see. The push carries
 * no field list, so the answer is `locations.getGoogleUpdated`'s diffMask. `before` is the
 * merchant's value (a normal locations.get), `after` what Google shows. Only the editable profile
 * fields are compared (attributes are not covered by this call); mask entries outside them
 * (address, ...) are kept as names with no values. null = nothing differs.
 */
export async function detectGoogleSuggestion(
  client: SuggestionReader,
  googleLocationId: string,
): Promise<GoogleSuggestion | null> {
  const updated = await client.getGoogleUpdated(googleLocationId, {
    readMask: PROFILE_LIMITS.readMask,
  });
  const outputOnly: readonly string[] = PROFILE_LIMITS.outputOnlyDiffMaskFields.list;
  const entries = (updated.diffMask ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && !outputOnly.some((o) => m === o || m.startsWith(`${o}.`)));
  if (entries.length === 0) return null;
  const { snapshot: merchant } = await fetchProfile(client, googleLocationId);
  const google = snapshotFromGoogle(updated.location, null);
  const out: GoogleSuggestion = {
    fieldPaths: [],
    before: { fields: {}, attributes: {} },
    after: { fields: {}, attributes: {} },
  };
  for (const f of PROFILE_FIELDS) {
    if (!entries.some((m) => covers(FIELD_MASK[f], m))) continue;
    if (same(merchant.fields[f], google.fields[f])) continue;
    out.fieldPaths.push(f);
    out.before.fields[f] = merchant.fields[f] ?? null;
    out.after.fields[f] = google.fields[f] ?? null;
  }
  for (const m of entries) {
    if (!PROFILE_FIELDS.some((f) => covers(FIELD_MASK[f], m))) out.fieldPaths.push(m);
  }
  return out.fieldPaths.length === 0 ? null : out;
}

/**
 * Phase 2 (inside the worker's transaction): store the suggestion as an open `google_suggested`
 * change and alert. The same suggestion pushed again while an open one exists is not stored twice
 * (returns null, so the caller keeps its generic notification).
 */
export async function recordGoogleSuggestion(
  tx: Tx,
  loc: WatchLocation,
  s: GoogleSuggestion,
): Promise<{ id: string; recipientCount: number } | null> {
  const open = await tx
    .select()
    .from(profileChanges)
    .where(
      and(
        eq(profileChanges.locationId, loc.id),
        eq(profileChanges.googleSuggested, true),
        eq(profileChanges.status, "open"),
      ),
    );
  const key = canonicalJson({ p: s.fieldPaths, a: s.after });
  if (open.some((o) => canonicalJson({ p: o.fieldPaths, a: o.after }) === key)) return null;
  return insertChange(tx, loc, { ...s, source: "push", googleSuggested: true });
}
