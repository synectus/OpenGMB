import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb, locations, locationWriteOps, notifications } from "@opengmb/db";
import { GoogleApiError } from "./google/errors";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { ReadOnlyGoogleClient } from "./google/read-only-client";
import { ThrottledGoogleClient } from "./google/throttled-client";
import { PostgresRateLimiter, currentProjectBucket, locationEditBucket } from "./google/throttler";
import { LOCATION_OP_QUEUE, processLocationOp } from "./locationOps/jobs";
import {
  CUSTOMER_MEDIA_SCAN_QUEUE,
  enqueueCustomerMediaScans,
  processCustomerMediaScan,
} from "./media/customer";
import { publishMediaCreate } from "./media/publish";
import { codeOf, makeKit, type Loc, type Org } from "./testkit";

// The shared test database is also used by every other suite, often at the same time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const boss = new PgBoss(url);
const mock = new MockGoogleClient();
const client = new ThrottledGoogleClient(mock, db);
const kit = makeKit(db, mock);
const { run } = kit;

type Op = {
  id: string;
  status: string;
  error: string | null;
  kind: string;
  payload: Record<string, unknown>;
  result: { name?: string } | null;
};
type Item = {
  name: string;
  category: string | null;
  sourceUrl: string | null;
  attribution: { profileName: string | null } | null;
};

const IMG = "https://cdn.example.test/photos/front.jpg?sig=SECRETTOKEN";
const jobsFor = async (opId: string) =>
  (
    await sql<
      { id: string }[]
    >`select id from pgboss.job where name = ${LOCATION_OP_QUEUE} and data->>'opId' = ${opId}`
  ).length;
const opRow = async (id: string) =>
  (await db.select().from(locationWriteOps).where(eq(locationWriteOps.id, id)))[0]!;
const runOp = (id: string, extra: { isFinalAttempt?: boolean } = {}) =>
  processLocationOp(db, { opId: id }, { client, ...extra });
const mediaList = (org: Org, loc: Loc, actor = org.owner) =>
  run<{ items: Item[]; operations: Op[] }>(actor, "media.list", { locationId: loc.row.id });
const add = (org: Org, loc: Loc, category: string, sourceUrl = IMG, actor = org.manager) =>
  run<{ operation: Op }>(actor, "media.add", { locationId: loc.row.id, sourceUrl, category }).then(
    (r) => r.operation,
  );
const calls = (m: string) => mock.calls.filter((c) => c.method === m);

beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  setSharedMockGoogleClient(mock);
  await boss.start();
  await boss.createQueue(LOCATION_OP_QUEUE);
  await boss.createQueue(CUSTOMER_MEDIA_SCAN_QUEUE);
});
afterAll(async () => {
  await kit.deactivateAll();
  setSharedMockGoogleClient(null);
  await boss.stop();
  await sql.end();
});

describe("media.add / media.delete: asynchronous, guarded, idempotent", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("media.add only records a pending operation and queues a job; Google is not called and the URL is not fetched", async () => {
    const before = mock.callCount;
    const op = await add(org, loc, "EXTERIOR");
    expect(op).toMatchObject({
      status: "pending",
      kind: "add",
      payload: { category: "EXTERIOR", sourceUrl: IMG },
    });
    expect(mock.callCount).toBe(before);
    expect(await jobsFor(op.id)).toBe(1);
    const audits = await kit.auditRows(org.orgId, "media.add_requested");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ category: "EXTERIOR", host: "cdn.example.test" });
    expect(JSON.stringify(audits[0]!.after)).not.toContain("SECRETTOKEN");
  });

  it("the job writes through the guarded module with the location-edit bucket and settles the operation", async () => {
    const [pending] = await db
      .select()
      .from(locationWriteOps)
      .where(
        and(eq(locationWriteOps.locationId, loc.row.id), eq(locationWriteOps.status, "pending")),
      );
    const spy = vi.spyOn(PostgresRateLimiter.prototype, "acquire");
    expect(await runOp(pending!.id)).toBe("applied");
    const acquired = spy.mock.calls.slice();
    spy.mockRestore();
    const row = await opRow(pending!.id);
    expect(row).toMatchObject({ status: "applied", error: null });
    expect(row.result).toMatchObject({ name: expect.stringContaining(`${loc.parent}/media/`) });
    const listed = await mediaList(org, loc);
    expect(listed.items.map((i) => [i.category, i.sourceUrl])).toEqual([["EXTERIOR", IMG]]);
    expect(listed.operations.map((o) => o.status)).toEqual(["applied"]);
    // shares the profile edit bucket (read from the limiter, not the table: other suites clear it)
    expect(acquired.map((c) => c[0])).toEqual([
      locationEditBucket(loc.google),
      currentProjectBucket(),
    ]);
    const done = await kit.auditRows(org.orgId, "media.op_applied");
    expect(done).toHaveLength(1);
    expect(done[0]!.surface).toBe("worker");
    expect(JSON.stringify(done[0]!.after)).not.toContain("SECRETTOKEN");
    expect(await runOp(pending!.id)).toBe("ignored"); // already settled
  });

  it("COVER and PROFILE (the logo) replace the previous one; the logo has the fixed name .../media/profile", async () => {
    const c1 = await add(org, loc, "COVER", "https://cdn.example.test/c1.png");
    await runOp(c1.id);
    const c2 = await add(org, loc, "COVER", "https://cdn.example.test/c2.png");
    await runOp(c2.id);
    const logo = await add(org, loc, "PROFILE", "https://cdn.example.test/logo.png");
    await runOp(logo.id);
    const items = (await mediaList(org, loc)).items;
    expect(items.filter((i) => i.category === "COVER")).toHaveLength(1);
    expect(items.find((i) => i.category === "COVER")!.sourceUrl).toBe(
      "https://cdn.example.test/c2.png",
    );
    expect(items.find((i) => i.category === "PROFILE")!.name).toBe(`${loc.parent}/media/profile`);
  });

  it("a retry after Google applied the write but the settle was lost sends nothing twice (idempotency key media:<opId>)", async () => {
    const op = await add(org, loc, "INTERIOR", "https://cdn.example.test/in.jpg");
    const first = await publishMediaCreate(
      client,
      { orgId: org.orgId, opId: op.id, parent: loc.parent },
      { sourceUrl: "https://cdn.example.test/in.jpg", category: "INTERIOR" },
    );
    const n = calls("createMedia").length;
    expect(await runOp(op.id)).toBe("applied");
    expect(calls("createMedia").length).toBe(n); // stored response, no second Google call
    expect((await opRow(op.id)).result).toEqual({ name: first.name });
    expect(
      (await mediaList(org, loc)).items.filter(
        (i) => i.sourceUrl === "https://cdn.example.test/in.jpg",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["http", "http://cdn.example.test/a.jpg"],
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["credentials", "https://user:pw@cdn.example.test/a.jpg"],
    ["gif", "https://cdn.example.test/a.gif"],
    ["not a url", "cdn.example.test/a.jpg"],
  ])("rejects a %s source URL", async (_n, u) => {
    expect(await codeOf(add(org, loc, "EXTERIOR", u))).toBe("INVALID_INPUT");
  });

  it("rejects LOGO (a deprecated alias) and unknown categories", async () => {
    expect(await codeOf(add(org, loc, "LOGO"))).toBe("INVALID_INPUT");
    expect(await codeOf(add(org, loc, "SELFIE"))).toBe("INVALID_INPUT");
  });

  it("media.delete queues; the job deletes; an item Google no longer has still counts as deleted", async () => {
    const item = (await mediaList(org, loc)).items.find((i) => i.category === "EXTERIOR")!;
    const del = (
      await run<{ operation: Op }>(org.manager, "media.delete", {
        locationId: loc.row.id,
        mediaName: item.name,
      })
    ).operation;
    expect(del.status).toBe("pending");
    expect(await runOp(del.id)).toBe("applied");
    expect((await mediaList(org, loc)).items.some((i) => i.name === item.name)).toBe(false);
    const again = (
      await run<{ operation: Op }>(org.manager, "media.delete", {
        locationId: loc.row.id,
        mediaName: item.name,
      })
    ).operation;
    expect(await runOp(again.id)).toBe("applied"); // 404 from Google
    // another location's media cannot be named
    const other = await org.mkLoc(org.a);
    expect(
      await codeOf(
        run(org.manager, "media.delete", {
          locationId: loc.row.id,
          mediaName: `${other.parent}/media/x1`,
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("a Google 4xx fails only this operation with a reason code; an unexpected error retries, then fails on the last attempt", async () => {
    const loc2 = await org.mkLoc(org.a); // the edit bucket allows 10 writes a minute per location
    const a = await add(org, loc2, "TEAMS", "https://cdn.example.test/t.jpg");
    mock.failNext(
      1,
      () => new GoogleApiError(400, { error: { message: "bad image BODYTEXT" } }),
      "createMedia",
    );
    expect(await runOp(a.id)).toBe("failed");
    expect(await opRow(a.id)).toMatchObject({ status: "failed", error: "google_http_400" });
    const b = await add(org, loc2, "TEAMS", "https://cdn.example.test/t2.jpg");
    mock.failNext(2, () => new Error("socket hang up"), "createMedia");
    await expect(runOp(b.id)).rejects.toThrow("socket hang up");
    expect((await opRow(b.id)).status).toBe("pending");
    expect(await runOp(b.id, { isFinalAttempt: true })).toBe("failed");
    expect((await opRow(b.id)).error).toBe("unexpected_error");
    const failed = await kit.auditRows(org.orgId, "media.op_failed");
    expect(JSON.stringify(failed.map((f) => f.after))).not.toContain("BODYTEXT");
  });

  it("an inactive location fails the operation without calling Google", async () => {
    const gone = await org.mkLoc(org.a);
    const op = await add(org, gone, "ROOMS", "https://cdn.example.test/r.jpg");
    await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, gone.row.id));
    const n = mock.callCount;
    expect(await runOp(op.id)).toBe("failed");
    expect((await opRow(op.id)).error).toBe("location_inactive");
    expect(mock.callCount).toBe(n);
    expect(await codeOf(add(org, gone, "ROOMS"))).toBe("INVALID_INPUT");
  });

  it("client roles read but cannot write; another org cannot see the location", async () => {
    for (const actor of [org.viewerA, org.approverA]) {
      expect(await codeOf(add(org, loc, "EXTERIOR", IMG, actor))).toBe("FORBIDDEN");
      expect(
        await codeOf(
          run(actor, "media.delete", {
            locationId: loc.row.id,
            mediaName: `${loc.parent}/media/x`,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect((await mediaList(org, loc, actor)).items.length).toBeGreaterThan(0);
    }
    expect(await codeOf(add(org, loc, "EXTERIOR", IMG, org.approverB))).toBe("FORBIDDEN");
    const stranger = await kit.makeOrg();
    expect(await codeOf(add(org, loc, "EXTERIOR", IMG, stranger.owner))).toBe("NOT_FOUND");
    expect(await codeOf(mediaList(org, loc, stranger.owner))).toBe("NOT_FOUND");
  });
});

describe("customer photo monitoring", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  const scan = (l: Loc = loc) => processCustomerMediaScan(db, { locationId: l.row.id }, { client });
  const photoNotes = async (l: Loc = loc) =>
    (
      await db
        .select()
        .from(notifications)
        .where(
          and(eq(notifications.sourceType, "customer_media"), eq(notifications.orgId, l.row.orgId)),
        )
    ).filter((n) => n.userId === org.ownerId);

  it("the first scan is a baseline that notifies nothing", async () => {
    mock.addCustomerMedia(loc.parent, { profileName: "Pat Q" });
    expect(await scan()).toEqual({ status: "baseline", newPhotos: 0 });
    expect(await photoNotes()).toEqual([]);
    expect(await scan()).toEqual({ status: "scanned", newPhotos: 0 });
  });

  it("each new photo notifies once, with the location name and a link, never the image or the contributor", async () => {
    const a = mock.addCustomerMedia(loc.parent, { profileName: "Sam Reviewer" });
    mock.addCustomerMedia(loc.parent);
    expect(await scan()).toEqual({ status: "scanned", newPhotos: 2 });
    expect(await scan()).toEqual({ status: "scanned", newPhotos: 0 });
    const notes = await photoNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      kind: "media.customer_photo",
      title: `New customer photo at ${loc.row.name}`,
      link: `/locations/${loc.row.id}/media`,
    });
    expect(JSON.stringify(notes)).not.toContain("Sam Reviewer");
    expect(JSON.stringify(notes)).not.toContain("lh3.example.test");
    mock.addCustomerMedia(loc.parent);
    expect(await scan()).toEqual({ status: "scanned", newPhotos: 1 });
    expect(await photoNotes()).toHaveLength(3);
    expect(a).toContain(`${loc.parent}/media/`);
  });

  it("media.customer.list shows customer photos with attribution (viewers may read)", async () => {
    const r = await run<{ items: Item[] }>(org.viewerA, "media.customer.list", {
      locationId: loc.row.id,
    });
    expect(r.items.length).toBe(4);
    expect(r.items.find((i) => i.attribution?.profileName === "Pat Q")).toBeDefined();
  });

  it("skips inactive locations and the nightly fan-out queues one scan per active linked location", async () => {
    const off = await org.mkLoc(org.a, { status: "inactive" });
    expect(await scan(off)).toEqual({ status: "skipped", newPhotos: 0 });
    const mine = await org.mkLoc(org.a);
    const queued = await enqueueCustomerMediaScans(db, { orgId: org.orgId });
    expect(queued.enqueued).toBe(
      (await db.select().from(locations).where(eq(locations.orgId, org.orgId))).filter(
        (l) => l.status === "active" && l.googleLocationId && l.googleAccountName && l.connectionId,
      ).length,
    );
    const n = await sql<
      { n: string }[]
    >`select count(*)::text as n from pgboss.job where name = ${CUSTOMER_MEDIA_SCAN_QUEUE} and data->>'locationId' = ${mine.row.id}`;
    expect(Number(n[0]!.n)).toBe(1);
  });
});

describe("place action links", () => {
  let org: Org;
  let loc: Loc;
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });
  type Link = {
    name: string;
    uri: string;
    placeActionType: string;
    isPreferred: boolean;
    isEditable: boolean;
  };
  const links = (actor = org.owner) =>
    run<{ links: Link[]; operations: Op[] }>(actor, "placeActions.list", {
      locationId: loc.row.id,
    });
  const act = async (name: string, input: object, actor = org.manager) => {
    const op = (await run<{ operation: Op }>(actor, name, { locationId: loc.row.id, ...input }))
      .operation;
    expect(op.status).toBe("pending");
    return { op, outcome: await runOp(op.id) };
  };

  it("create, list, update (minimal mask), preferred swap and delete all go through jobs", async () => {
    const before = mock.callCount;
    const created = (
      await run<{ operation: Op }>(org.manager, "placeActions.create", {
        locationId: loc.row.id,
        placeActionType: "APPOINTMENT",
        uri: "https://book.example.test/a",
      })
    ).operation;
    expect(mock.callCount).toBe(before); // nothing at Google until the job runs
    expect(await runOp(created.id)).toBe("applied");
    const name = ((await opRow(created.id)).result as { name: string }).name;
    const second = await act("placeActions.create", {
      placeActionType: "APPOINTMENT",
      uri: "https://book.example.test/b",
      isPreferred: true,
    });
    expect(second.outcome).toBe("applied");
    const first = await act("placeActions.update", { name, isPreferred: true });
    expect(first.outcome).toBe("applied");
    const upd = calls("updatePlaceActionLink").at(-1)!;
    expect(upd.args[2]).toEqual(["isPreferred"]);
    const l = (await links()).links;
    expect(
      l
        .filter((x) => x.placeActionType === "APPOINTMENT")
        .map((x) => [x.uri, x.isPreferred])
        .sort(),
    ).toEqual([
      ["https://book.example.test/a", true],
      ["https://book.example.test/b", false],
    ]);
    const del = await act("placeActions.delete", { name });
    expect(del.outcome).toBe("applied");
    expect((await links()).links.some((x) => x.name === name)).toBe(false);
    expect((await links(org.viewerA)).operations.length).toBeGreaterThanOrEqual(4);
  });

  it("only https URIs: http, mailto, credentials and unknown types are rejected", async () => {
    for (const uri of [
      "http://book.example.test/x",
      "mailto:a@b.test",
      "https://u:p@book.example.test/x",
      "book.example.test",
    ]) {
      expect(
        await codeOf(
          run(org.manager, "placeActions.create", {
            locationId: loc.row.id,
            placeActionType: "APPOINTMENT",
            uri,
          }),
        ),
      ).toBe("INVALID_INPUT");
    }
    expect(
      await codeOf(
        run(org.manager, "placeActions.create", {
          locationId: loc.row.id,
          placeActionType: "TELEPORT",
          uri: "https://x.example.test",
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        run(org.manager, "placeActions.update", {
          locationId: loc.row.id,
          name: `${loc.google}/placeActionLinks/x`,
          uri: "http://x.example.test",
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await codeOf(
        run(org.manager, "placeActions.update", {
          locationId: loc.row.id,
          name: `${loc.google}/placeActionLinks/x`,
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("a duplicate (uri, type) and a link the merchant cannot edit fail with a reason code", async () => {
    const a = await act("placeActions.create", {
      placeActionType: "DINING_RESERVATION",
      uri: "https://table.example.test/r",
    });
    expect(a.outcome).toBe("applied");
    const dup = await act("placeActions.create", {
      placeActionType: "DINING_RESERVATION",
      uri: "https://table.example.test/r",
    });
    expect(dup.outcome).toBe("failed");
    expect((await opRow(dup.op.id)).error).toBe("google_http_409");
    const aggregator = (await links()).links.find((x) => !x.isEditable)!;
    expect(aggregator).toBeDefined();
    const u = await act("placeActions.update", { name: aggregator.name, isPreferred: true });
    expect(u.outcome).toBe("failed");
    const d = await act("placeActions.delete", { name: aggregator.name });
    expect(d.outcome).toBe("failed");
    expect((await opRow(d.op.id)).error).toBe("google_http_400");
    // a link of another location cannot be named
    expect(
      await codeOf(
        run(org.manager, "placeActions.delete", {
          locationId: loc.row.id,
          name: "locations/999/placeActionLinks/x",
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("client roles cannot write; audit rows carry the host, not the URI", async () => {
    for (const actor of [org.viewerA, org.approverA]) {
      expect(
        await codeOf(
          run(actor, "placeActions.create", {
            locationId: loc.row.id,
            placeActionType: "APPOINTMENT",
            uri: "https://x.example.test/p",
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(
          run(actor, "placeActions.delete", {
            locationId: loc.row.id,
            name: `${loc.google}/placeActionLinks/x`,
          }),
        ),
      ).toBe("FORBIDDEN");
    }
    const rows = await kit.auditRows(org.orgId, "place_action.create_requested");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.after).toMatchObject({ host: expect.any(String) });
    expect(JSON.stringify(rows.map((r) => r.after))).not.toContain('/a"');
  });
});

describe("Google writes off (live mode without GOOGLE_BUSINESS_WRITES=live)", () => {
  let org: Org;
  let loc: Loc;
  const readOnly = new ThrottledGoogleClient(new ReadOnlyGoogleClient(mock), db);
  beforeAll(async () => {
    org = await kit.makeOrg();
    loc = await org.mkLoc(org.a);
  });

  it("canary: an added photo is recorded pending, then the worker fails it as google_writes_disabled without writing", async () => {
    const op = await add(org, loc, "EXTERIOR");
    expect(op.status).toBe("pending");
    const before = calls("createMedia").length;
    expect(await processLocationOp(db, { opId: op.id }, { client: readOnly })).toBe("failed");
    expect(await opRow(op.id)).toMatchObject({ status: "failed", error: "google_writes_disabled" });
    // The read-only wrapper refuses before the (mock) Google is reached.
    expect(calls("createMedia").length).toBe(before);
  });

  it("a delete fails the same way and media.list reports the code", async () => {
    const del = await run<{ operation: Op }>(org.manager, "media.delete", {
      locationId: loc.row.id,
      mediaName: `${loc.parent}/media/does-not-matter`,
    });
    expect(await processLocationOp(db, { opId: del.operation.id }, { client: readOnly })).toBe(
      "failed",
    );
    const listed = await mediaList(org, loc);
    expect(listed.operations.find((o) => o.id === del.operation.id)).toMatchObject({
      status: "failed",
      error: "google_writes_disabled",
    });
  });
});
