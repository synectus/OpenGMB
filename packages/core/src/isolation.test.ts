/**
 * H1 isolation test: every action in the registry is called as a user of one tenant with the ids of
 * another tenant, and must either be refused or return nothing of the other tenant. The other
 * tenant's rows must also be byte-for-byte unchanged afterwards.
 *
 * Two scenarios, both driven from the registry (a new action cannot be skipped silently):
 *   org    an org A owner uses org B's ids
 *   client a client_approver of workspace A1 uses workspace A2's ids (same org, other client)
 *
 * An action whose input carries no tenant id must be listed in NO_TENANT_INPUT with a reason; an
 * action with a tenant id must not be. An id-looking field that nothing maps fails the test.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";
import type { z } from "zod";
import * as dbSchema from "@opengmb/db";
import {
  createDb,
  locations as locationsTable,
  memberships,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import type { Db } from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { writeAudit } from "./audit";
import { CoreError } from "./errors";
import { InvalidInputError, executeAction } from "./executor";
import { actions } from "./actions";
import { HOSTED_ID_KIND, HOSTED_NO_TENANT_INPUT, HOSTED_NON_TENANT_ID_FIELDS, HOSTED_POOL_ROWS } from "./isolation-hosted";
import { sampleInput } from "./sample-input";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** Every text value seeded for a tenant contains its own mark, so a leak is greppable. */
let MARK = "TNT_unset";

// ---------------------------------------------------------------------------
// Generic row seeding: fill every NOT NULL column without a default, from `ctx` by column name,
// else by type. Nullable columns stay null.
// ---------------------------------------------------------------------------
type Ctx = Record<string, unknown>;

function dummy(col: PgColumn, table: string): unknown {
  if (col.enumValues && col.enumValues.length > 0) return col.enumValues[0];
  switch (col.dataType) {
    case "string":
      if (col.columnType === "PgUUID") return crypto.randomUUID();
      if (col.columnType === "PgNumeric") return "1";
      if (col.columnType === "PgDateString") return "2026-01-01";
      return `${MARK}-${table}-${col.name}-${uniq()}`;
    case "number":
      return 1;
    case "boolean":
      return false;
    case "date":
      return new Date("2030-01-01T00:00:00Z");
    case "json":
      return {};
    case "array":
      return [`${MARK}-${table}-${col.name}`];
    case "buffer":
      return Buffer.from("x");
    case "bigint":
      return 1;
    case "custom":
      return Buffer.from("x");
    default:
      throw new Error(`no dummy for ${table}.${col.name} (${col.dataType})`);
  }
}

async function seed(
  d: Db,
  table: PgTable,
  ctx: Ctx,
  over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const cfg = getTableConfig(table);
  const values: Record<string, unknown> = {};
  const fkCols = new Set(cfg.foreignKeys.flatMap((f) => f.reference().columns.map((c) => c.name)));
  const cols = Object.entries((table as unknown as Record<string, PgColumn>) ?? {}).filter(
    ([, c]) => typeof c === "object" && c !== null && "columnType" in c,
  );
  for (const [key, col] of cols) {
    if (key in over) values[key] = over[key];
    else if (col.name in ctx) values[key] = ctx[col.name];
    else if (/_by$/.test(col.name) && col.notNull && "user_id" in ctx) values[key] = ctx.user_id;
    else if (col.notNull && !col.hasDefault) {
      if (fkCols.has(col.name)) {
        throw new Error(`seed ${cfg.name}: foreign key ${col.name} has no value in ctx`);
      }
      values[key] = dummy(col, cfg.name);
    }
  }
  const [row] = await d
    .insert(table)
    .values(values as never)
    .returning();
  return row as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// A tenant: org + user + workspace + one of every kind of tenant-owned thing.
// ---------------------------------------------------------------------------
type Pool = {
  mark: string;
  orgId: string;
  userId: string;
  userEmail: string;
  workspaceId: string;
  membershipId: string;
  connectionId: string;
  locationId: string;
  citationId: string;
  groupId: string;
  importId: string;
  syncId: string;
  reviewId: string;
  replyId: string;
  postId: string;
  templateId: string;
  postTemplateId: string;
  postImageId: string;
  apiTokenId: string;
  webhookId: string;
  invitationId: string;
  gridConfigId: string;
  gridRunId: string;
  reportDefId: string;
  reportRunId: string;
  batchId: string;
  opId: string;
  shareLinkId: string;
  changeSetId: string;
  profileChangeId: string;
  caseId: string;
  proposalId: string;
  campaignId: string;
  notificationId: string;
};

const T = dbSchema as unknown as Record<string, PgTable>;
const tbl = (name: string): PgTable => {
  const t = T[name];
  if (!t) throw new Error(`schema export ${name} not found`);
  return t;
};
const idOf = (r: Record<string, unknown>) => r.id as string;

async function seedUser(tag: string) {
  const id = `u-${tag}-${uniq()}`;
  const email = `${id}@example.test`;
  await db.insert(users).values({ id, name: `${MARK}-user-${tag}`, email });
  return { id, email };
}

async function seedTenant(opts: {
  orgId: string;
  tag: string;
  /** "owner" gives the user an org-wide owner membership; "client" a client_approver one. */
  membership: "owner" | "client";
}): Promise<Pool> {
  const { orgId, tag } = opts;
  MARK = `TNT_${tag}_${uniq()}`;
  const user = await seedUser(tag);
  const [ws] = await db
    .insert(workspaces)
    .values({ orgId, name: `${MARK}-ws-${tag}-${uniq()}` })
    .returning();
  const workspaceId = ws!.id;
  const [m] = await db
    .insert(memberships)
    .values(
      opts.membership === "owner"
        ? { orgId, userId: user.id, role: "owner" }
        : { orgId, userId: user.id, role: "client_approver", workspaceId },
    )
    .returning();
  const base: Ctx = { org_id: orgId, workspace_id: workspaceId, user_id: user.id };

  const conn = await seed(db, tbl("googleConnections"), base);
  const c1: Ctx = { ...base, connection_id: idOf(conn) };
  const loc = await seed(db, locationsTable, c1, {
    googleLocationId: `locations/${MARK}${uniq()}`,
    googleAccountName: `accounts/${MARK}${uniq()}`,
  });
  const c2: Ctx = { ...c1, location_id: idOf(loc) };
  const group = await seed(db, tbl("locationGroups"), c2);
  await seed(db, tbl("locationGroupMembers"), { ...c2, group_id: idOf(group) });
  const imp = await seed(db, tbl("locationImports"), { ...c2, requested_by: user.id });
  const sync = await seed(db, tbl("reviewSyncs"), c2);
  const review = await seed(db, tbl("reviews"), c2);
  const c3: Ctx = { ...c2, review_id: idOf(review) };
  const reply = await seed(db, tbl("reviewReplies"), c3, { status: "draft" });
  await seed(db, tbl("reviewLinks"), c3);
  const campaign = await seed(db, tbl("reviewRequestCampaigns"), c3);
  await seed(db, tbl("locationPages"), c3);
  const citation = await seed(db, tbl("citationEntries"), c3, { customName: "a custom site" });
  const post = await seed(db, tbl("posts"), { ...c2, status: "draft" });
  await seed(db, tbl("postTargets"), { ...c2, post_id: idOf(post) });
  const template = await seed(db, tbl("replyTemplates"), c3);
  const postTemplate = await seed(db, tbl("postTemplates"), c3);
  const postImage = await seed(db, tbl("postImages"), c3);
  const token = await seed(db, tbl("apiTokens"), c3);
  const webhook = await seed(db, tbl("webhookSubscriptions"), c3, {
    createdByUserId: user.id,
    url: "https://3.3.3.3/hook",
    events: ["review.created"],
  });
  const hosted: Record<string, string> = {};
  for (const r of HOSTED_POOL_ROWS) hosted[r.key] = idOf(await seed(db, tbl(r.table), { ...c3, ...r.ctx(user.id) }, r.over));
  const gridConfig = await seed(db, tbl("gridConfigs"), c3, { gridSize: 3 });
  const gridRun = await seed(db, tbl("gridRuns"), { ...c3, config_id: idOf(gridConfig) });
  const reportDef = await seed(db, tbl("reportDefinitions"), c3);
  const reportRun = await seed(db, tbl("reportRuns"), { ...c3, definition_id: idOf(reportDef) });
  const share = await seed(db, tbl("reportShareLinks"), {
    ...c3,
    report_run_id: idOf(reportRun),
    created_by: user.id,
  });
  const changeSet = await seed(db, tbl("profileChangeSets"), { ...c3, created_by: user.id });
  const profileChange = await seed(db, tbl("profileChanges"), c3);
  const kase = await seed(db, tbl("suspensionCases"), c3);
  const proposal = await seed(
    db,
    tbl("mcpProposals"),
    { ...c3, token_id: idOf(token) },
    { status: "pending" },
  );
  const batchId = crypto.randomUUID();
  const writeOp = await seed(db, tbl("locationWriteOps"), c3, { batchId, domain: "media", kind: "add" });
  const notification = await seed(db, tbl("notifications"), c3);
  await seed(db, tbl("healthcheckSkips"), { ...c3, check_id: "name" });
  await db.transaction((tx) =>
    writeAudit(tx, {
      orgId,
      actorUserId: user.id,
      actorType: "user",
      surface: "ui",
      action: `${MARK}.seed`,
      entityType: "workspace",
      entityId: workspaceId,
      before: null,
      after: { marker: MARK },
    }),
  );
  return {
    mark: MARK,
    orgId,
    userId: user.id,
    userEmail: user.email,
    workspaceId,
    membershipId: m!.id,
    connectionId: idOf(conn),
    locationId: idOf(loc),
    citationId: idOf(citation),
    groupId: idOf(group),
    importId: idOf(imp),
    syncId: idOf(sync),
    reviewId: idOf(review),
    replyId: idOf(reply),
    postId: idOf(post),
    templateId: idOf(template),
    postTemplateId: idOf(postTemplate),
    postImageId: idOf(postImage),
    apiTokenId: idOf(token),
    webhookId: idOf(webhook),
    invitationId: hosted.invitationId ?? "",
    gridConfigId: idOf(gridConfig),
    gridRunId: idOf(gridRun),
    reportDefId: idOf(reportDef),
    reportRunId: idOf(reportRun),
    batchId,
    opId: idOf(writeOp),
    shareLinkId: idOf(share),
    changeSetId: idOf(changeSet),
    profileChangeId: idOf(profileChange),
    caseId: idOf(kase),
    proposalId: idOf(proposal),
    campaignId: idOf(campaign),
    notificationId: idOf(notification),
  };
}

// ---------------------------------------------------------------------------
// Which input field carries which foreign id.
// ---------------------------------------------------------------------------
/** `id` fields mean different entities per action family. First matching prefix wins. */
const ID_KIND: [prefix: string, key: keyof Pool][] = [
  ["apiTokens.", "apiTokenId"],
  ["webhooks.", "webhookId"],
  ["googleConnections.", "connectionId"],
  ["reviewReplies.", "replyId"],
  ["replyTemplates.", "templateId"],
  ["postImages.", "postImageId"],
  ["postTemplates.", "postTemplateId"],
  ["posts.", "postId"],
  ["geogrid.configs.", "gridConfigId"],
  ["reports.definitions.", "reportDefId"],
  ["profile.changes.", "profileChangeId"],
  ["profile.", "changeSetId"],
  ["reviews.", "reviewId"],
  ["suspension.cases.", "caseId"],
  ["citations.", "citationId"],
  ...(HOSTED_ID_KIND as [string, keyof Pool][]),
];

function poolValue(action: string, field: string, p: Pool): unknown {
  switch (field) {
    case "orgId":
      return p.orgId;
    case "workspaceId":
      return p.workspaceId;
    case "locationId":
      return p.locationId;
    case "locationIds":
      return [p.locationId];
    case "groupId":
      return p.groupId;
    case "connectionId":
      return p.connectionId;
    case "importId":
      return p.importId;
    case "syncIds":
      return [p.syncId];
    case "reviewId":
      return p.reviewId;
    case "reviewIds":
      return [p.reviewId];
    case "assigneeUserId":
      return p.userId;
    case "configId":
      return p.gridConfigId;
    case "definitionId":
      return p.reportDefId;
    case "linkId":
      return p.shareLinkId;
    case "membershipId":
      return p.membershipId;
    case "proposalId":
      return p.proposalId;
    case "campaignId":
      return p.campaignId;
    case "templateId":
      return p.templateId;
    case "imageId":
    case "photoImageId":
      return p.postImageId;
    case "actorUserId":
      return p.userId;
    case "ids":
      return [p.notificationId];
    case "batchId":
      return p.batchId;
    case "opId":
      return p.opId;
    case "runId":
      return action.startsWith("geogrid.") ? p.gridRunId : p.reportRunId;
    case "id": {
      const hit = ID_KIND.find(([prefix]) => action.startsWith(prefix));
      return hit ? p[hit[1]] : undefined;
    }
    default:
      return undefined;
  }
}

/** Fields that look like ids but carry no tenant data: cursors and Google/vendor identifiers. */
const NON_TENANT_ID_FIELDS: Record<string, string> = {
  beforeId: "audit paging cursor; only narrows A's own rows",
  afterId: "audit paging cursor; only narrows A's own rows",
  driverId: "ranking provider name, an enum",
  placeId: "Google place id typed by the user, not a stored reference",
  targetPlaceId: "Google place id typed by the user, not a stored reference",
  checkId: "healthcheck check name, an enum",
  mediaName: "Google resource name; guarded by the locationId check before any Google call",
  categoryName: "Google category name",
  names: "Google category names",
  ...HOSTED_NON_TENANT_ID_FIELDS,
};

/** Actions with no tenant id in their input: scoped only by who is calling. Each needs a reason. */
const NO_TENANT_INPUT: Record<string, string> = {
  "workspaces.list": "lists the caller's own workspaces",
  "workspaces.create": "creates in the caller's own org",
  "onboarding.get": "the caller's own org first-run flags",
  "onboarding.update": "the caller's own org first-run flags",
  "aiSwitch.get": "the caller's own org AI switch and own notice flag",
  "aiSwitch.update": "the caller's own org AI switch",
  "aiNotice.acknowledge": "the caller's own notice flag",
  "audit.verify": "the caller's own org audit chain",
  "audit.export": "the caller's own org audit log",
  "apiTokens.list": "the caller's own tokens",
  "apiTokens.current": "describes the caller's own org, user and token",
  "webhooks.list": "the caller's own org webhooks",
  "apiTokens.create": "creates for the caller",
  "googleConnections.list": "the caller's own org connections",
  "googleConnections.connect": "starts an OAuth flow for the caller's org",
  "googleConnections.connectSample": "adds the sample account to the caller's own org (mock mode only)",
  "notifications.list": "the caller's own notifications",
  "geogrid.preview": "pure price calculation, reads nothing tenant-owned",
  "geogrid.settings.get": "the caller's own org settings",
  "geogrid.settings.update": "the caller's own org settings",
  "geogrid.byoKey.get": "the caller's own org key status",
  "geogrid.byoKey.set": "the caller's own org key",
  "geogrid.byoKey.delete": "the caller's own org key",
  "geogrid.byoKey.verify": "the caller's own org key",
  "geogrid.usage": "the caller's own org usage",
  "branding.get": "the caller's own org branding",
  "branding.update": "the caller's own org branding",
  "branding.logos": "the caller's own org logo file ids, limited to the clients in their scope",
  "storage.usage": "the caller's own org storage usage",
  "mcp.proposals.list": "the caller's own proposals",
  "system.status": "global service status, no tenant data",
  "monitoring.overview": "platform administrators only; global server health, no tenant data",
  "aiUsage.get": "the caller's own org AI usage",
  "googleNotifications.status": "platform administrators only; server-wide Pub/Sub registration state, no tenant data",
  "googleNotifications.registerAll": "platform administrators only; registers every connected Google account on the server-wide topic, takes no id",
  ...HOSTED_NO_TENANT_INPUT,
};

function tenantFields(action: (typeof actions)[number], p: Pool): string[] {
  const shape = (action.input as z.ZodObject).shape as Record<string, unknown>;
  return Object.keys(shape).filter((k) => poolValue(action.name, k, p) !== undefined);
}

function buildInput(action: (typeof actions)[number], p: Pool): Record<string, unknown> {
  const input = sampleInput(action, (k) => poolValue(action.name, k, p));
  // Both runId and configId are mapped; the action wants exactly one.
  if (action.name === "geogrid.competitors")
    return { ...input, runId: p.gridRunId, configId: undefined };
  return input;
}

// ---------------------------------------------------------------------------
// Snapshot of everything the foreign tenant owns, to prove an action left it untouched.
// ---------------------------------------------------------------------------
type Scope =
  { kind: "org"; orgId: string } | { kind: "client"; workspaceId: string; locationIds: string[] };

const SCHEMA_TABLES = Object.values(dbSchema).filter((v) => is(v, PgTable)) as unknown as PgTable[];

function columnsOf(t: PgTable): Record<string, PgColumn> {
  return Object.fromEntries(getTableConfig(t).columns.map((c) => [c.name, c]));
}

async function snapshot(scope: Scope): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of SCHEMA_TABLES) {
    const cols = columnsOf(t);
    let where;
    if (scope.kind === "org") {
      if (!cols.org_id) continue;
      where = eq(cols.org_id, scope.orgId);
    } else if (cols.workspace_id) {
      where = eq(cols.workspace_id, scope.workspaceId);
    } else if (cols.location_id) {
      where = inArray(cols.location_id, scope.locationIds);
    } else continue;
    const rows = await db.select().from(t).where(where);
    out[getTableName(t)] = createHash("sha256")
      .update(JSON.stringify(rows.map((r) => JSON.stringify(r)).sort()))
      .digest("hex");
  }
  return out;
}

function changedTables(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => before[k] !== after[k],
  );
}

// ---------------------------------------------------------------------------
type Scenario = {
  label: string;
  actor: Actor;
  foreign: Pool;
  scope: Scope;
};

let scenarios: Scenario[] = [];
let fetchCalls: string[] = [];

beforeAll(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error("network disabled in the isolation test");
  });
  const [orgA] = await db
    .insert(organizations)
    .values({ name: `iso-A-${uniq()}` })
    .returning();
  const [orgB] = await db
    .insert(organizations)
    .values({ name: `iso-B-${uniq()}` })
    .returning();
  const a1 = await seedTenant({ orgId: orgA!.id, tag: "A1", membership: "owner" });
  const a2 = await seedTenant({ orgId: orgA!.id, tag: "A2", membership: "client" });
  const b = await seedTenant({ orgId: orgB!.id, tag: "B", membership: "owner" });
  // A client user who only sees workspace A1 (a second client in org A is A2).
  const clientUser = await seedUser("A1client");
  await db.insert(memberships).values({
    orgId: orgA!.id,
    userId: clientUser.id,
    role: "client_approver",
    workspaceId: a1.workspaceId,
  });
  const ownerA = await loadActor(db, { userId: a1.userId, surface: "ui", actorType: "user" });
  const clientA1 = await loadActor(db, {
    userId: clientUser.id,
    surface: "ui",
    actorType: "user",
  });
  expect(clientA1.workspaceIds).toEqual([a1.workspaceId]);
  scenarios = [
    {
      label: "org A owner -> org B",
      actor: ownerA,
      foreign: b,
      scope: { kind: "org", orgId: b.orgId },
    },
    {
      label: "client of A1 -> client A2 (same org)",
      actor: clientA1,
      foreign: a2,
      scope: { kind: "client", workspaceId: a2.workspaceId, locationIds: [a2.locationId] },
    },
  ];
}, 120_000);

/** Text that proves foreign data (names, emails) and ids of foreign rows. */
function needlesOf(p: Pool, includeOrg: boolean): { text: string[]; ids: string[] } {
  return {
    text: [p.mark, p.userEmail],
    ids: [
      p.userId,
      ...Object.entries(p)
        .filter(([k]) => k !== "orgId" && k !== "mark" && k !== "userEmail" && k !== "userId")
        .map(([, v]) => v as string),
      ...(includeOrg ? [p.orgId] : []),
    ],
  };
}

/** The first foreign value found in `text`; ids the caller itself passed in are an echo, not a leak. */
function findLeak(text: string, input: unknown, n: { text: string[]; ids: string[] }) {
  let rest = text;
  for (const echoed of JSON.stringify(input ?? {}).match(/[0-9a-f-]{36}|u-[\w-]+/g) ?? []) {
    rest = rest.split(echoed).join("");
  }
  return [...n.text, ...n.ids].find((v) => rest.includes(v));
}

type Outcome = "refused" | "empty-or-own" | "invalid-input" | "crashed" | "leaked" | "mutated";

describe("tenant isolation over the whole action registry", () => {
  it("the registry is non-empty and the declared no-tenant-input list has no stale names", () => {
    expect(actions.length).toBeGreaterThan(0);
    const names = new Set(actions.map((a) => a.name));
    expect(Object.keys(NO_TENANT_INPUT).filter((n) => !names.has(n))).toEqual([]);
  });

  for (let s = 0; s < 2; s++) {
    it(`scenario ${s === 0 ? "org A owner -> org B" : "client of A1 -> client A2"}`, async () => {
      const sc = scenarios[s]!;
      const needles = needlesOf(sc.foreign, sc.scope.kind === "org");

      const counts: Record<Outcome, number> = {
        refused: 0,
        "empty-or-own": 0,
        "invalid-input": 0,
        crashed: 0,
        leaked: 0,
        mutated: 0,
      };
      const problems: string[] = [];
      const noTenant: string[] = [];
      let checked = 0;
      let withForeignId = 0;

      for (const action of actions) {
        const fields = tenantFields(action, sc.foreign);
        const declared = action.name in NO_TENANT_INPUT;
        if (fields.length === 0 && !declared) {
          problems.push(`${action.name}: no tenant id in its input and not in NO_TENANT_INPUT`);
          continue;
        }
        if (fields.length > 0 && declared) {
          problems.push(`${action.name}: has tenant fields ${fields} but is in NO_TENANT_INPUT`);
        }
        const shape = (action.input as z.ZodObject).shape as Record<string, unknown>;
        for (const k of Object.keys(shape)) {
          if (
            /(^|[a-z])Ids?$|^ids?$/.test(k) &&
            poolValue(action.name, k, sc.foreign) === undefined
          ) {
            if (!(k in NON_TENANT_ID_FIELDS)) {
              problems.push(`${action.name}: id field "${k}" is not mapped to a foreign id`);
            }
          }
        }
        if (fields.length === 0) noTenant.push(action.name);
        else withForeignId++;

        const input = buildInput(action, sc.foreign);
        const before = action.kind === "write" ? await snapshot(sc.scope) : null;
        fetchCalls = [];
        let outcome: Outcome;
        let detail = "";
        try {
          const result = await executeAction(db, sc.actor, action.name, input);
          const text = JSON.stringify(result ?? null);
          const hit = findLeak(text, input, needles);
          if (hit) {
            outcome = "leaked";
            detail = `result contains foreign value ${hit}`;
          } else outcome = "empty-or-own";
        } catch (e) {
          if (e instanceof InvalidInputError) {
            outcome = "invalid-input";
            detail = e.message;
          } else if (e instanceof CoreError) {
            const text = e.message;
            const hit = findLeak(text, input, needles);
            if (hit) {
              outcome = "leaked";
              detail = `error message contains foreign value ${hit}`;
            } else outcome = "refused";
          } else {
            outcome = "crashed";
            detail = String((e as Error)?.stack ?? e).slice(0, 300);
          }
        }
        if (before) {
          const changed = changedTables(before, await snapshot(sc.scope));
          if (changed.length > 0) {
            outcome = "mutated";
            detail = `foreign rows changed in: ${changed.join(", ")}`;
          }
        }
        if (fields.length > 0 && fetchCalls.length > 0) {
          outcome = "leaked";
          detail = `called out to the network with foreign ids: ${fetchCalls.join(", ")}`;
        }
        counts[outcome]++;
        checked++;
        if (process.env.ISO_VERBOSE)
          console.log(`[iso-detail] ${action.kind} ${action.name} ${outcome}`);
        if (
          outcome === "leaked" ||
          outcome === "mutated" ||
          outcome === "invalid-input" ||
          outcome === "crashed"
        ) {
          problems.push(`${action.name} [${outcome}] ${detail}`);
        }
      }

      console.log(
        `[isolation] ${sc.label}: checked ${checked} of ${actions.length} actions ` +
          `(${withForeignId} with foreign ids, ${noTenant.length} declared no-tenant-input); ` +
          JSON.stringify(counts),
      );
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(0);
      expect(checked).toBe(actions.length);
    }, 600_000);
  }

  it("canary: the leak detector does fire on foreign data", async () => {
    const sc = scenarios[0]!;
    // Calling as the foreign tenant's own owner must show its own data: proves needles match.
    const own = await loadActor(db, {
      userId: sc.foreign.userId,
      surface: "ui",
      actorType: "user",
    });
    const result = await executeAction(db, own, "workspaces.list", {});
    const text = JSON.stringify(result);
    expect(findLeak(text, {}, needlesOf(sc.foreign, true))).toBeDefined();
    // And a seeded row of the foreign tenant is visible to the snapshot.
    const snap = await snapshot(sc.scope);
    expect(Object.keys(snap).length).toBeGreaterThan(10);
  });
});
