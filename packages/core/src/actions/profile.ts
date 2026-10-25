import { and, asc, desc, eq, exists, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  locations,
  profileChangeSets,
  profileChangeTargets,
  users,
  workspaces,
  type Db,
  type Tx,
} from "@opengmb/db";
import { AccessError, authorize, workspaceScope, type Actor } from "../actor";
import { PROFILE_BATCH_MAX_LOCATIONS } from "../config/profile-limits";
import { CoreError } from "../errors";
import type { GuardrailResult } from "../guardrails";
import { enqueueJob } from "../jobs";
import { guardrailPreview } from "./previewUtil";
import { GoogleOrgLimitError } from "../google/errors";
import { MockGoogleClient } from "../google/mock-client";
import type { ThrottledGoogleClient } from "../google/throttled-client";
import { PROFILE_METADATA } from "../config/profile-metadata";
import { defineAction } from "../registry";
import { googleFailure, clientFor } from "../reviews/reply-jobs";
import {
  computeDiff,
  desiredValues,
  profileFieldsInput,
  serviceItemInput,
  planServiceAdds,
  snapshotWithCategories,
  withMergedCategories,
  withMergedServices,
  snapshotFromJson,
  touchedNames,
  type ProfileDiff,
  type ProfileValues,
} from "../profile/fields";
import { categoriesCompetitorsHaveThatLocationLacks } from "../competitors/categoryGaps";
import { getCompetitorCategories } from "../competitors/categories";
import { fetchProfile, PROFILE_GET_READ_MASK, profileDisplay } from "../profile/fetch";
import { checkProfile } from "../profile/guardrails";
import { getCategories, listAttributes, metadataLocale, searchCategories } from "../profile/metadata";
import { PROFILE_APPLY_QUEUE } from "../profile/jobs";
import { recordChangeSet } from "../profile/propose";
import { changeSetCapabilities, transitionChangeSet, type ChangeSetRow } from "../profile/state";

const violationOut = z.object({
  ruleId: z.string(),
  packId: z.string(),
  severity: z.enum(["block", "warn"]),
  status: z.enum(["active", "pending_counsel_review"]),
  message: z.string(),
  matches: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).optional(),
});
const guardrailOut = z.object({
  ok: z.boolean(),
  violations: z.array(violationOut),
  packs: z.array(z.string()),
});

const valuesOut = z.object({
  fields: z.record(z.string(), z.unknown()),
  attributes: z.record(z.string(), z.unknown()),
});
const changeOut = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });

const statusOut = z.enum([
  "draft",
  "pending_approval",
  "approved",
  "queued",
  "applied",
  "partially_applied",
  "failed",
  "blocked",
  "cancelled",
]);

const targetOut = z.object({
  id: z.string(),
  locationId: z.string(),
  locationName: z.string(),
  status: z.enum(["pending", "applied", "failed", "skipped", "no_change"]),
  /** A reason code: conflict, guardrail_blocked:<rules>, google_http_<n>, location_inactive ... */
  error: z.string().nullable(),
  appliedAt: z.string().nullable(),
  changes: z.array(changeOut),
  updateMask: z.array(z.string()),
  attributeMask: z.array(z.string()),
});

const changeSetOut = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: statusOut,
  /** The desired values (normalised): fields by name, attributes by `attributes/{id}` (null = delete). */
  fields: valuesOut,
  /** Union of the Google field-mask entries over the targets; each target has its own minimal mask. */
  updateMask: z.array(z.string()),
  createdBy: z.string(),
  createdSurface: z.string(),
  /** users.name of createdBy. For an agent draft (createdSurface mcp) this is the token owner. */
  createdByName: z.string().nullable(),
  /** users.name of the approver; null until approved. */
  approvedByName: z.string().nullable(),
  guardrail: guardrailOut.nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  targets: z.array(targetOut),
  createdAt: z.string(),
  updatedAt: z.string(),
  can: z.object({
    approve: z.boolean(),
    reject: z.boolean(),
    apply: z.boolean(),
    cancel: z.boolean(),
  }),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;
const NOT_FOUND = () => new AccessError("NOT_FOUND", "Change set not found");

type TargetJoined = typeof profileChangeTargets.$inferSelect & { locationName: string };

async function targetsFor(tx: Tx, ids: string[]): Promise<Map<string, TargetJoined[]>> {
  const map = new Map<string, TargetJoined[]>();
  if (ids.length === 0) return map;
  const rows = await tx
    .select({ t: profileChangeTargets, locationName: locations.name })
    .from(profileChangeTargets)
    .innerJoin(locations, eq(locations.id, profileChangeTargets.locationId))
    .where(inArray(profileChangeTargets.changeSetId, ids))
    .orderBy(asc(locations.name), asc(profileChangeTargets.id));
  for (const { t, locationName } of rows) {
    const list = map.get(t.changeSetId) ?? [];
    list.push({ ...t, locationName });
    map.set(t.changeSetId, list);
  }
  return map;
}

async function namesFor(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (want.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toOut(
  actor: Actor,
  r: ChangeSetRow,
  targets: TargetJoined[],
  names: Map<string, string>,
): z.input<typeof changeSetOut> {
  const c = changeSetCapabilities(actor, r.status);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    status: r.status,
    fields: r.fields as ProfileValues,
    updateMask: r.updateMask,
    createdBy: r.createdBy,
    createdSurface: r.createdSurface,
    createdByName: names.get(r.createdBy) ?? null,
    approvedByName: r.approvedBy ? (names.get(r.approvedBy) ?? null) : null,
    guardrail: (r.guardrailResult as GuardrailResult | null) ?? null,
    submittedAt: iso(r.submittedAt),
    approvedAt: iso(r.approvedAt),
    rejectedAt: iso(r.rejectedAt),
    rejectReason: r.rejectReason,
    cancelledAt: iso(r.cancelledAt),
    targets: targets.map((t) => {
      const d = t.diff as ProfileDiff;
      return {
        id: t.id,
        locationId: t.locationId,
        locationName: t.locationName,
        status: t.status,
        error: t.error,
        appliedAt: iso(t.appliedAt),
        changes: d.changes,
        updateMask: d.updateMask,
        attributeMask: d.attributeMask,
      };
    }),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    can: {
      approve: c.canApprove,
      reject: c.canReject,
      apply: c.canApply,
      cancel: c.canCancel,
    },
  };
}

async function outFor(tx: Tx, actor: Actor, row: ChangeSetRow) {
  const map = await targetsFor(tx, [row.id]);
  const names = await namesFor(tx, [row.createdBy, row.approvedBy]);
  return toOut(actor, row, map.get(row.id) ?? [], names);
}

/** A change set the actor can see (same org, workspace in scope), otherwise NOT_FOUND; then the permission check. */
async function loadChangeSet(
  tx: Tx,
  actor: Actor,
  id: string,
  permission: Parameters<typeof authorize>[1],
  lock = true,
): Promise<ChangeSetRow> {
  const q = tx
    .select()
    .from(profileChangeSets)
    .where(and(eq(profileChangeSets.id, id), eq(profileChangeSets.orgId, actor.orgId)));
  const [cs] = lock ? await q.for("update") : await q;
  if (!cs) throw NOT_FOUND();
  const scope = workspaceScope(actor);
  if (scope !== "all" && !scope.includes(cs.workspaceId)) throw NOT_FOUND();
  authorize(actor, permission, { workspaceId: cs.workspaceId });
  return cs;
}

type LocRow = typeof locations.$inferSelect;

/** Locations of the actor's org visible in their scope, with the permission checked per workspace. */
async function visibleLocations(
  db: Db | Tx,
  actor: Actor,
  ids: string[],
  permission: Parameters<typeof authorize>[1],
): Promise<LocRow[]> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select()
    .from(locations)
    .where(and(inArray(locations.id, unique), eq(locations.orgId, actor.orgId)));
  const scope = workspaceScope(actor);
  const visible = rows.filter((l) => scope === "all" || scope.includes(l.workspaceId));
  if (visible.length !== unique.length) throw new AccessError("NOT_FOUND", "Location not found");
  for (const l of visible) authorize(actor, permission, { workspaceId: l.workspaceId });
  return unique.map((id) => visible.find((l) => l.id === id)!);
}

/** One workspace, active and linked to Google; used by preview and propose. */
function requireEditable(rows: LocRow[]): string {
  const workspaceIds = new Set(rows.map((l) => l.workspaceId));
  if (workspaceIds.size !== 1) {
    throw new CoreError(
      "INVALID_INPUT",
      "All locations of one change set must be in one workspace",
    );
  }
  for (const l of rows) {
    if (l.status !== "active") {
      throw new CoreError("INVALID_INPUT", "Unknown or inactive location for this workspace");
    }
  }
  return rows[0]!.workspaceId;
}

const locationIdsInput = z.array(z.uuid()).min(1).max(PROFILE_BATCH_MAX_LOCATIONS);

const attributeOut = z.object({
  name: z.string(),
  valueType: z.string().nullable(),
  value: z.unknown(),
});

export const profileGet = defineAction({
  name: "profile.get",
  description:
    "Read a location's editable Business Profile live from Google (the mock, today): title, description, categories (primary + additional ids), regularHours, specialHours, serviceItems, serviceArea, websiteUri, openingDate, phoneNumbers, storeCode, storefrontAddress, plus attributes (each `attributes/{id}` with its value type). Values are normalised: unset fields are null; hours periods are sorted. Calls Google, so it runs outside any database transaction. Also returns display: Google's category display names by id, (the store code and address are in profile.fields.storeCode and storefrontAddress). display.regionCode and display.languageCode are the locale to pass to profile.categories.* and profile.attributes.metadata.",
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    location: z.object({ id: z.string(), name: z.string(), workspaceId: z.string() }),
    profile: valuesOut,
    attributes: z.array(attributeOut),
    display: z.object({
      categoryNames: z.record(z.string(), z.string()),
      regionCode: z.string(),
      languageCode: z.string(),
    }),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const [loc] = await visibleLocations(db, actor, [input.locationId], "location:read");
    const client = await clientForLocation(db, actor, loc!);
    const { snapshot, attributes, location } = await fetchProfile(
      client,
      loc!.googleLocationId!,
      PROFILE_GET_READ_MASK,
    );
    return {
      location: { id: loc!.id, name: loc!.name, workspaceId: loc!.workspaceId },
      profile: snapshot,
      attributes: attributes.map((a) => ({
        name: a.name,
        valueType: a.valueType ?? null,
        value: snapshot.attributes[a.name] ?? null,
      })),
      display: profileDisplay(location),
    };
  },
});

async function clientForLocation(db: Db, actor: Actor, loc: LocRow) {
  if (!loc.googleLocationId) {
    throw new CoreError("INVALID_INPUT", "Location is not linked to Google");
  }
  const client = await clientFor(db, actor.orgId, loc.connectionId);
  if (!client) throw new CoreError("NOT_CONFIGURED", "Location has no Google connection");
  return client;
}

/** Append these to each location's current services (instead of `fields.serviceItems`, which replaces the list). */
const addServiceItemsInput = z.array(serviceItemInput).min(1).max(300).optional();
const ADD_SERVICES_DOC =
  " `addServiceItems` appends services to each location's CURRENT list (an item with the same name and category is skipped, everything else is kept as it is); it cannot be combined with `fields.serviceItems`, which replaces the whole list. With addServiceItems, `fields` may be empty. `skipUnofferedServices: true` (used by Copy services) also sets aside, per location, free-form items whose category is not one of the location's, structured items whose service type none of the location's categories offers (or that could not be verified), and everything when the merged list would pass 300 items; each location's `serviceAdd` says which (`send`, `alreadyThere`, `skipped` with a reason, as indexes into addServiceItems). Google documents no category rule or item limit, so this is conservative: flag rather than send. An existing item with the same name and category keeps its own price and description. profile.propose takes the preview's `serviceAdd.send` as `serviceAddSend`.";
const skipUnoffered = z.boolean().optional();
/** Append these to each location's current categories (instead of `fields.categories`, which replaces them). */
const addCategoriesInput = z.array(z.object({ name: z.string().min(1).max(200) })).min(1).max(20).optional();
const ADD_CATEGORIES_DOC =
  " `addCategories` adds categories ([{ name }], Google ids such as categories/gcid:dentist) to each location's CURRENT additional categories: the primary and every category already there are kept, and one already there is skipped. It cannot be combined with `fields.categories`, which replaces both. A location without a primary category errors in the preview. With `addServiceItems` + `skipUnofferedServices`, each location's services are checked against its categories AFTER the edit (the additions, or `fields.categories` when that replaces them).";
const serviceAddOut = z.object({
  send: z.array(z.number().int()),
  alreadyThere: z.array(z.number().int()),
  skipped: z.array(
    z.object({
      index: z.number().int(),
      reason: z.enum(["category_not_on_location", "type_not_offered", "type_unverified", "over_cap"]),
    }),
  ),
});

/** `fields` as desired values; with `addServiceItems` the additions stand in for serviceItems. */
function desiredFrom(
  fields: z.input<typeof profileFieldsInput>,
  add: z.input<typeof serviceItemInput>[] | undefined,
  addCats?: { name: string }[],
) {
  if (add && fields.serviceItems !== undefined) {
    throw new CoreError("INVALID_INPUT", "Use either serviceItems or addServiceItems, not both");
  }
  if (addCats && fields.categories !== undefined) {
    throw new CoreError("INVALID_INPUT", "Use either categories or addCategories, not both");
  }
  return desiredValues({
    ...fields,
    ...(add ? { serviceItems: add } : {}),
    ...(addCats ? { categories: { primaryCategory: addCats[0]!, additionalCategories: addCats.slice(1) } } : {}),
  });
}

type ServiceAddOut = z.infer<typeof serviceAddOut>;

/** The snapshot with the categories the location will have after this edit (added or replaced), for planning services. */
function afterCategories(snapshot: ProfileValues, desired: ProfileValues, addCats: { name: string }[] | undefined): ProfileValues {
  if (addCats) return snapshotWithCategories(snapshot, addCats);
  return desired.fields.categories === undefined
    ? snapshot
    : { ...snapshot, fields: { ...snapshot.fields, categories: desired.fields.categories } };
}

/** The service type ids the location's categories offer; "unverified" when Google's list could not be read. */
async function offeredTypes(
  client: Parameters<typeof getCategories>[0],
  snapshot: ProfileValues,
  locale: { regionCode: string; languageCode: string },
): Promise<Set<string> | "unverified"> {
  const c = snapshot.fields.categories as
    | { primaryCategory?: { name?: string }; additionalCategories?: { name?: string }[] }
    | null
    | undefined;
  const names = [c?.primaryCategory?.name, ...(c?.additionalCategories ?? []).map((x) => x.name)]
    .filter((n): n is string => Boolean(n))
    .slice(0, PROFILE_METADATA.batchGetMaxNames);
  if (names.length === 0) return new Set();
  try {
    const cats = await getCategories(client, { ...locale, names });
    return new Set(cats.flatMap((x) => x.serviceTypes.map((t) => t.serviceTypeId)));
  } catch {
    return "unverified";
  }
}
const isOffered = (item: unknown, offered: Set<string> | "unverified" | null) =>
  offered instanceof Set &&
  offered.has((item as { structuredServiceItem?: { serviceTypeId?: string } }).structuredServiceItem?.serviceTypeId ?? "");

const previewLocationOut = z.object({
  locationId: z.string(),
  locationName: z.string(),
  /** Set when this location could not be read; the other fields are then empty. */
  error: z.string().nullable(),
  /** Full normalised current profile: pass it back as `snapshots[].current` to profile.propose. */
  current: valuesOut.nullable(),
  changes: z.array(changeOut),
  /** Minimal locations.patch updateMask: only the fields that differ. */
  updateMask: z.array(z.string()),
  /** Minimal updateAttributes attributeMask: only the attributes that differ. */
  attributeMask: z.array(z.string()),
  noChange: z.boolean(),
  guardrail: guardrailOut.nullable(),
  /** Only with addServiceItems and skipUnofferedServices. */
  serviceAdd: serviceAddOut.nullable(),
});

export const profilePreview = defineAction({
  name: "profile.preview",
  description:
    "Dry run of a profile edit across one or more locations of one workspace. Reads each location's current profile live from Google (outside any transaction), diffs it against `fields`, and returns per location { changes, updateMask, attributeMask, guardrail, noChange, current }. Only fields that differ are in the updateMask. `fields` sets whole values: title, description (max 750 characters, no links), categories { primaryCategory { name }, additionalCategories [{ name }] } (Google category ids such as categories/gcid:dentist), regularHours { periods [{ openDay MONDAY..SUNDAY, openTime {hours, minutes}, closeDay, closeTime }] } (24 hours open is 00:00 to 24:00), specialHours { specialHourPeriods [{ startDate {year,month,day}, endDate, openTime, closeTime, closed }] }, serviceItems, serviceArea, websiteUri, openingDate {year,month,day}, phoneNumbers { primaryPhone, additionalPhones }, storeCode (null clears) and storefrontAddress { regionCode, postalCode, administrativeArea, locality, addressLines (max 5) } (the whole address; changing it adds the warning PR.address-reverification, because Google may send the location back to verification), and attributes { 'attributes/has_wifi': { values: [true] } | null (null deletes) }. null clears websiteUri, regularHours, specialHours, serviceArea, openingDate. Guardrails (pack profile + U7) run on the values to be written. Writes nothing. To propose, pass the same `fields` (and `addServiceItems`) and each location's `current` as snapshots to profile.propose." + ADD_SERVICES_DOC + ADD_CATEGORIES_DOC,
  input: z.object({
    locationIds: locationIdsInput,
    fields: profileFieldsInput,
    addServiceItems: addServiceItemsInput,
    addCategories: addCategoriesInput,
    skipUnofferedServices: skipUnoffered,
  }),
  output: z.object({ locations: z.array(previewLocationOut) }),
  permission: "profile:edit",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const desired = desiredFrom(input.fields, input.addServiceItems, input.addCategories);
    assertSomething(desired);
    if (input.skipUnofferedServices && !input.addServiceItems) {
      throw new CoreError("INVALID_INPUT", "skipUnofferedServices needs addServiceItems");
    }
    const locs = await visibleLocations(db, actor, input.locationIds, "profile:edit");
    requireEditable(locs);
    const out: z.input<typeof previewLocationOut>[] = [];
    for (const loc of locs) {
      const base = {
        locationId: loc.id,
        locationName: loc.name,
        error: null as string | null,
        current: null as ProfileValues | null,
        changes: [] as ProfileDiff["changes"],
        updateMask: [] as string[],
        attributeMask: [] as string[],
        noChange: false,
        guardrail: null as GuardrailResult | null,
        serviceAdd: null as ServiceAddOut | null,
      };
      try {
        const client = await clientForLocation(db, actor, loc);
        const check = Boolean(input.skipUnofferedServices && input.addServiceItems);
        const { snapshot, location } = await fetchProfile(
          client,
          loc.googleLocationId!,
          check ? PROFILE_GET_READ_MASK : undefined,
        );
        let target = desired;
        let serviceAdd: ServiceAddOut | null = null;
        // Services are planned against the categories the location will have after the additions.
        const after = afterCategories(snapshot, desired, input.addCategories);
        if (input.addCategories) target = withMergedCategories(target, snapshot, input.addCategories);
        if (input.addServiceItems) {
          const add = input.addServiceItems;
          const offered = check ? await offeredTypes(client, after, metadataLocale(location)) : null;
          const plan = planServiceAdds(after, add, {
            checkOffers: check,
            structuredOk: (i) => (offered === "unverified" ? "unverified" : isOffered(add[i], offered)),
          });
          if (check) serviceAdd = plan;
          target = withMergedServices(target, snapshot, add, plan.send);
        }
        const diff = computeDiff(snapshot, target);
        out.push({
          ...base,
          current: snapshot,
          changes: diff.changes,
          updateMask: diff.updateMask,
          attributeMask: diff.attributeMask,
          noChange: diff.changes.length === 0,
          guardrail:
            diff.changes.length === 0
              ? null
              : checkProfile(diff.after, { name: loc.title ?? loc.name, phone: loc.phone }, diff.before).result,
          serviceAdd,
        });
      } catch (e) {
        out.push({
          ...base,
          error:
            googleFailure(e) ??
            (e instanceof GoogleOrgLimitError ? e.message : e instanceof CoreError ? e.code : "unexpected_error"),
        });
      }
    }
    return { locations: out };
  },
});

function assertSomething(d: ProfileValues) {
  if (touchedNames(d).length === 0) throw new CoreError("INVALID_INPUT", "No fields to change");
}

export const profilePropose = defineAction({
  name: "profile.propose",
  description:
    "Record a profile change set: ONE edit (`fields`) for 1-100 locations of one workspace, with the preview snapshot each diff is based on. Pass `snapshots` = the `current` of each location from profile.preview. Per location the diff and minimal updateMask are recomputed here; locations where nothing changes become no_change targets (at least one location must change). Guardrails run on every changing location: any block-severity violation sets status blocked (returned, not an error; propose again with corrected fields); otherwise the change set is pending_approval (warnings do not block). Nothing is sent to Google. The snapshot is the baseline for the conflict check: if Google's value of a changed field differs from it when applying, that location fails with error `conflict` and nothing is written there. Needs profile:edit; approval needs review:approve." + ADD_SERVICES_DOC + ADD_CATEGORIES_DOC,
  input: z.object({
    workspaceId: z.uuid(),
    locationIds: locationIdsInput,
    fields: profileFieldsInput,
    addServiceItems: addServiceItemsInput,
    addCategories: addCategoriesInput,
    skipUnofferedServices: skipUnoffered,
    /** The preview's `serviceAdd.send` per location. It can only remove structured items from the additions, never add. */
    serviceAddSend: z.array(z.object({ locationId: z.uuid(), indexes: z.array(z.number().int()) })).max(100).optional(),
    snapshots: z
      .array(z.object({ locationId: z.uuid(), current: z.record(z.string(), z.unknown()) }))
      .min(1)
      .max(100),
  }),
  output: z.object({ changeSet: changeSetOut, result: guardrailOut }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async preview({ read }, input) {
    const out = (await read("profile.preview", {
      locationIds: input.locationIds,
      fields: input.fields,
      addServiceItems: input.addServiceItems,
      addCategories: input.addCategories,
      skipUnofferedServices: input.skipUnofferedServices,
    })) as { locations: { changes: unknown[]; guardrail: GuardrailResult | null }[] };
    const all = out.locations.flatMap((l) => (l.guardrail ? [l.guardrail] : []));
    return guardrailPreview(
      "Profile change",
      {
        ok: all.every((g) => g.ok),
        violations: all.flatMap((g) => g.violations),
        packs: [...new Set(all.flatMap((g) => g.packs))],
      },
      { locations: out.locations },
    );
  },
  async handler({ tx, actor, audit }, input) {
    authorize(actor, "profile:edit", { workspaceId: input.workspaceId });
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, actor.orgId)));
    if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
    const locs = await visibleLocations(tx, actor, input.locationIds, "profile:edit");
    if (requireEditable(locs) !== input.workspaceId) {
      throw new CoreError("INVALID_INPUT", "Unknown or inactive location for this workspace");
    }
    const desired = desiredFrom(input.fields, input.addServiceItems, input.addCategories);
    assertSomething(desired);
    const add = input.addServiceItems;
    const addCats = input.addCategories;
    if (input.skipUnofferedServices && !add) {
      throw new CoreError("INVALID_INPUT", "skipUnofferedServices needs addServiceItems");
    }
    const check = Boolean(input.skipUnofferedServices && add);
    // The structured-type verdicts came from the preview (Google cannot be called in here); the
    // free-form category and the cap are recomputed from the baseline.
    const previewed = new Map((input.serviceAddSend ?? []).map((s) => [s.locationId, new Set(s.indexes)]));

    const { row, result } = await recordChangeSet(tx, actor, audit, {
      workspaceId: input.workspaceId,
      locs,
      desired,
      desiredFor:
        add || addCats
          ? (snapshot, loc) => {
              const withCats = addCats ? withMergedCategories(desired, snapshot, addCats) : desired;
              if (!add) return withCats;
              const after = afterCategories(snapshot, desired, addCats);
              return withMergedServices(
                withCats,
                snapshot,
                add,
                planServiceAdds(after, add, {
                  checkOffers: check,
                  structuredOk: (i) => previewed.get(loc.id)?.has(i) ?? false,
                }).send,
              );
            }
          : undefined,
      baseline: (loc) => {
        const snap = input.snapshots.find((s) => s.locationId === loc.id);
        if (!snap) throw new CoreError("INVALID_INPUT", `Missing snapshot for location ${loc.id}`);
        return snapshotFromJson(snap.current);
      },
    });
    return { changeSet: await outFor(tx, actor, row), result };
  },
});

export const profileApprove = defineAction({
  name: "profile.approve",
  description:
    "Approve a change set that is pending approval (pending_approval -> approved). Approving does not send anything to Google: call profile.apply. Client approvers can approve change sets in their own workspaces only.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ changeSet: changeSetOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const cs = await loadChangeSet(tx, actor, input.id, "review:approve");
    const row = await transitionChangeSet(tx, {
      changeSet: cs,
      to: "approved",
      action: "approved",
      set: { approvedBy: actor.userId, approvedAt: new Date() },
      audit,
    });
    return { changeSet: await outFor(tx, actor, row) };
  },
});

export const profileReject = defineAction({
  name: "profile.reject",
  description:
    "Reject a change set that is pending approval, with a reason (pending_approval -> cancelled). The proposer edits the values and proposes again.",
  input: z.object({ id: z.uuid(), reason: z.string().min(1).max(2_000) }),
  output: z.object({ changeSet: changeSetOut }),
  permission: "review:approve",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const cs = await loadChangeSet(tx, actor, input.id, "review:approve");
    const row = await transitionChangeSet(tx, {
      changeSet: cs,
      to: "cancelled",
      action: "rejected",
      set: {
        rejectedBy: actor.userId,
        rejectedAt: new Date(),
        rejectReason: input.reason,
        cancelledBy: actor.userId,
        cancelledAt: new Date(),
      },
      audit,
      extra: { reasonLength: input.reason.length },
    });
    await skipPending(tx, cs.id, "rejected");
    return { changeSet: await outFor(tx, actor, row) };
  },
});

async function skipPending(tx: Tx, changeSetId: string, reason: string) {
  await tx
    .update(profileChangeTargets)
    .set({ status: "skipped", error: reason, updatedAt: new Date() })
    .where(
      and(
        eq(profileChangeTargets.changeSetId, changeSetId),
        eq(profileChangeTargets.status, "pending"),
      ),
    );
}

export const profileApply = defineAction({
  name: "profile.apply",
  description:
    "Apply an approved change set: approved -> queued and one worker job per changing location (no_change locations are skipped). Asynchronous: nothing is sent to Google inside this call. Each job re-reads the location from Google; if a changed field no longer has the value the preview saw, that location fails with error `conflict` and nothing is written there (someone edited it on Google). Otherwise guardrails run again and the edit is written with a minimal updateMask through the per-location queue (Google allows 10 edits per minute per location; an 11th waits). The change set ends applied (all changing locations applied), partially_applied or failed. Poll profile.changeSets.get for per-location results.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ changeSet: changeSetOut, jobsQueued: z.number().int() }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const cs = await loadChangeSet(tx, actor, input.id, "profile:edit");
    if (cs.status !== "approved") {
      throw new CoreError(
        "CONFLICT",
        `Only an approved change set can be applied (this one is ${cs.status})`,
      );
    }
    const pending = await tx
      .select({ id: profileChangeTargets.id })
      .from(profileChangeTargets)
      .where(
        and(
          eq(profileChangeTargets.changeSetId, cs.id),
          eq(profileChangeTargets.status, "pending"),
        ),
      )
      .orderBy(asc(profileChangeTargets.id));
    if (pending.length === 0) throw new CoreError("CONFLICT", "Change set has nothing to apply");
    const row = await transitionChangeSet(tx, {
      changeSet: cs,
      to: "queued",
      action: "apply_requested",
      set: { appliedRequestedBy: actor.userId, appliedRequestedAt: new Date() },
      audit,
      extra: { requestedBy: actor.userId, targetCount: pending.length },
    });
    for (const t of pending) await enqueueJob(tx, PROFILE_APPLY_QUEUE, { targetId: t.id });
    return { changeSet: await outFor(tx, actor, row), jobsQueued: pending.length };
  },
});

export const profileCancel = defineAction({
  name: "profile.cancel",
  description:
    "Cancel a change set that has not been applied: draft, blocked, pending_approval or approved. Once applying has started (queued) it cannot be cancelled: CONFLICT.",
  input: z.object({ id: z.uuid() }),
  output: z.object({ changeSet: changeSetOut }),
  permission: "profile:edit",
  kind: "write",
  approval: "own_flow",
  async handler({ tx, actor, audit }, input) {
    const cs = await loadChangeSet(tx, actor, input.id, "profile:edit");
    if (!changeSetCapabilities(actor, cs.status).canCancel) {
      throw new CoreError("CONFLICT", `A ${cs.status} change set cannot be cancelled`);
    }
    const row = await transitionChangeSet(tx, {
      changeSet: cs,
      to: "cancelled",
      action: "cancelled",
      set: { cancelledBy: actor.userId, cancelledAt: new Date() },
      audit,
    });
    await skipPending(tx, cs.id, "cancelled");
    return { changeSet: await outFor(tx, actor, row) };
  },
});

export const profileChangeSetsGet = defineAction({
  name: "profile.changeSets.get",
  description:
    "One profile change set: desired values, status, guardrail result, what the caller may do next (can.*) and the per-location results (status, error reason code, the field changes and masks). Each change set names its drafter (createdByName; createdSurface mcp means an agent drafted it for that person) and approver (approvedByName).",
  input: z.object({ id: z.uuid() }),
  output: z.object({ changeSet: changeSetOut }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    const cs = await loadChangeSet(tx, actor, input.id, "location:read", false);
    return { changeSet: await outFor(tx, actor, cs) };
  },
});

export const profileChangeSetsList = defineAction({
  name: "profile.changeSets.list",
  description:
    "Profile change sets the caller can see, newest first. Filters: workspaceId, status, locationId (change sets that target it). limit 1-100 (default 50). Use status pending_approval for the approval queue. Each change set names its drafter (createdByName; createdSurface mcp means an agent drafted it for that person) and approver (approvedByName).",
  input: z.object({
    workspaceId: z.uuid().optional(),
    status: statusOut.optional(),
    locationId: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ changeSets: z.array(changeSetOut) }),
  permission: "location:read",
  kind: "read",
  async handler({ tx, actor }, input) {
    if (input.workspaceId) authorize(actor, "location:read", { workspaceId: input.workspaceId });
    const scope = workspaceScope(actor);
    const rows = await tx
      .select()
      .from(profileChangeSets)
      .where(
        and(
          eq(profileChangeSets.orgId, actor.orgId),
          scope === "all" ? undefined : inArray(profileChangeSets.workspaceId, scope),
          input.workspaceId ? eq(profileChangeSets.workspaceId, input.workspaceId) : undefined,
          input.status ? eq(profileChangeSets.status, input.status) : undefined,
          input.locationId
            ? exists(
                tx
                  .select({ one: sql`1` })
                  .from(profileChangeTargets)
                  .where(
                    and(
                      eq(profileChangeTargets.changeSetId, profileChangeSets.id),
                      eq(profileChangeTargets.locationId, input.locationId),
                    ),
                  ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(profileChangeSets.createdAt), desc(profileChangeSets.id))
      .limit(input.limit);
    const targets = await targetsFor(
      tx,
      rows.map((r) => r.id),
    );
    const names = await namesFor(tx, rows.flatMap((r) => [r.createdBy, r.approvedBy]));
    return { changeSets: rows.map((r) => toOut(actor, r, targets.get(r.id) ?? [], names)) };
  },
});

const localeInput = {
  regionCode: z.string().regex(/^[A-Z]{2}$/, "regionCode is an ISO 3166-1 alpha-2 code such as US"),
  languageCode: z
    .string()
    .regex(
      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
      "languageCode is a BCP 47 code such as en or en-AU",
    ),
};
const sourceOut = z.enum(["google", "sample"]);
const sourceOf = (c: ThrottledGoogleClient): "google" | "sample" =>
  c.inner instanceof MockGoogleClient ? "sample" : "google";
const categoryName = z
  .string()
  .regex(/^categories\/[A-Za-z0-9_:.-]+$/, "category names look like categories/gcid:dentist");

/** The location only picks the Google connection and checks scope; metadata is not per location. */
async function metadataClient(db: Db, actor: Actor, locationId: string) {
  const [loc] = await visibleLocations(db, actor, [locationId], "location:read");
  return clientForLocation(db, actor, loc!);
}

export const profileCategoriesSearch = defineAction({
  name: "profile.categories.search",
  description: `Search Google's Business Profile categories by display name, for a region and language (pass display.regionCode and display.languageCode from profile.get). Returns up to ${PROFILE_METADATA.searchPageSize} { name (the id to write, categories/gcid:...), displayName }. Fewer than ${PROFILE_METADATA.searchMinChars} characters returns nothing without calling Google. Cached for a day per query. source "sample" means this server uses the simulated Google.`,
  input: z.object({ locationId: z.uuid(), ...localeInput, query: z.string().max(100) }),
  output: z.object({
    categories: z.array(z.object({ name: z.string(), displayName: z.string() })),
    source: sourceOut,
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const client = await metadataClient(db, actor, input.locationId);
    return { categories: await searchCategories(client, input), source: sourceOf(client) };
  },
});

export const profileCategoriesGet = defineAction({
  name: "profile.categories.get",
  description: `Google's details for up to ${PROFILE_METADATA.batchGetMaxNames} category ids (categories/gcid:...): displayName and serviceTypes (the structured services a location in that category can list; write them as serviceItems[].structuredServiceItem.serviceTypeId). Unknown ids are left out. Cached for a day per id.`,
  input: z.object({
    locationId: z.uuid(),
    ...localeInput,
    names: z.array(categoryName).min(1).max(PROFILE_METADATA.batchGetMaxNames),
  }),
  output: z.object({
    categories: z.array(
      z.object({
        name: z.string(),
        displayName: z.string(),
        serviceTypes: z.array(z.object({ serviceTypeId: z.string(), displayName: z.string() })),
      }),
    ),
    source: sourceOut,
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const client = await metadataClient(db, actor, input.locationId);
    return { categories: await getCategories(client, input), source: sourceOf(client) };
  },
});

/** Most suggestions one location shows; the rest are the long tail of single-competitor categories. */
const CATEGORY_SUGGESTIONS_MAX = 10;

export const profileCategoriesSuggestions = defineAction({
  name: "profile.categories.suggestions",
  description: `Categories that the ranking competitors of a location's geo-grid trackers use and this location lacks (K3). Each suggestion has the category name as the competitors write it, how many of the profiled competitors use it (competitors), how many use it as their primary (asPrimary) and the evidence: those competitors with their rank (1 = seen at the most grid points in the stored scans), appearances and whether it is their primary. Up to ${CATEGORY_SUGGESTIONS_MAX}, most used first. Reads the location's categories live from Google and the stored competitor profiles (never calls DataForSEO). status "no_competitor_data" means no tracker has competitor profiles yet: refresh competitors on the geo-grid Competitors tab first. dataSource is fixture, sandbox or live. To add one: find its Google id with profile.categories.search (query = the name), then profile.preview and profile.propose with addCategories; that records a change set that waits for approval and writes nothing to Google. Needs location:read.`,
  input: z.object({ locationId: z.uuid() }),
  output: z.object({
    locationId: z.string(),
    status: z.enum(["ok", "no_competitor_data"]),
    dataSource: z.enum(["fixture", "sandbox", "live"]).nullable(),
    /** Competitors with a stored profile that the suggestions are drawn from. */
    competitorCount: z.number().int(),
    /** The location's own categories (display names). */
    ownCategories: z.array(z.string()),
    display: z.object({ regionCode: z.string(), languageCode: z.string() }),
    suggestions: z.array(
      z.object({
        name: z.string(),
        competitors: z.number().int(),
        asPrimary: z.number().int(),
        evidence: z.array(
          z.object({
            placeId: z.string(),
            title: z.string(),
            rank: z.number().int(),
            appearances: z.number().int(),
            isPrimary: z.boolean(),
          }),
        ),
      }),
    ),
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const [loc] = await visibleLocations(db, actor, [input.locationId], "location:read");
    const client = await clientForLocation(db, actor, loc!);
    const { snapshot, location } = await fetchProfile(client, loc!.googleLocationId!, PROFILE_GET_READ_MASK);
    const display = profileDisplay(location);
    const cats = snapshot.fields.categories as
      | { primaryCategory?: { name?: string }; additionalCategories?: { name?: string }[] }
      | null
      | undefined;
    const ownCategories = [cats?.primaryCategory?.name, ...(cats?.additionalCategories ?? []).map((c) => c.name)]
      .filter((n): n is string => Boolean(n))
      .map((id) => display.categoryNames[id] ?? id);
    const competitors = await getCompetitorCategories(db, actor.orgId, loc!.id);
    return {
      locationId: loc!.id,
      status: competitors.competitors.length === 0 ? ("no_competitor_data" as const) : ("ok" as const),
      dataSource: competitors.dataSource,
      competitorCount: competitors.competitors.length,
      ownCategories,
      display: { regionCode: display.regionCode, languageCode: display.languageCode },
      suggestions: categoriesCompetitorsHaveThatLocationLacks(competitors, ownCategories).slice(0, CATEGORY_SUGGESTIONS_MAX),
    };
  },
});

export const profileAttributesMetadata = defineAction({
  name: "profile.attributes.metadata",
  description:
    "The attributes Google offers for a primary category in a region and language: name (attributes/{id}, the key for profile.preview attributes), displayName, groupDisplayName, valueType (BOOL, ENUM, URL, REPEATED_ENUM), repeatable, and for enums the allowed values with display names. Deprecated attributes are left out. Social profile links, where Google offers them, are URL attributes such as attributes/url_facebook. Cached for a day per category.",
  input: z.object({ locationId: z.uuid(), ...localeInput, categoryName }),
  output: z.object({
    attributes: z.array(
      z.object({
        name: z.string(),
        displayName: z.string(),
        groupDisplayName: z.string(),
        valueType: z.enum(["BOOL", "ENUM", "URL", "REPEATED_ENUM"]),
        repeatable: z.boolean(),
        values: z.array(z.object({ value: z.unknown(), displayName: z.string() })),
      }),
    ),
    source: sourceOut,
  }),
  permission: "location:read",
  kind: "read",
  outsideTransaction: true,
  async handler({ db, actor }, input) {
    const client = await metadataClient(db, actor, input.locationId);
    return { attributes: await listAttributes(client, input), source: sourceOf(client) };
  },
});
