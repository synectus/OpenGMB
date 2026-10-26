import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createDb, locationDataAccess, workspaces } from "@opengmb/db";
import { READ_ONLY_REFUSED_READS, ReadOnlyViewError, READ_ONLY_VIEW_MESSAGE, authorizeAction, viewAsActor } from "./actor";
import { actions } from "./actions";
import { runAssistantTurn } from "./ai/assistant";
import { executeAction, executeToolCall, runParsed } from "./executor";
import { GoogleApiError } from "./google/errors";
import { setSharedMockGoogleClient } from "./google/factory";
import { MockGoogleClient } from "./google/mock-client";
import { defineAction } from "./registry";
import { roleHasPermission } from "./permissions";
import { makeKit } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: pg } = createDb(url);
const mock = new MockGoogleClient();
const kit = makeKit(db, mock);
setSharedMockGoogleClient(mock);
afterAll(async () => {
  setSharedMockGoogleClient(null);
  await kit.deactivateAll();
  await pg.end();
});

const ro = (userId: string, orgId: string) => viewAsActor({ userId, orgId });
const attempt = (fn: () => unknown) => {
  try {
    fn();
    return "allowed";
  } catch (e) {
    return e instanceof ReadOnlyViewError ? "read-only" : `other:${String(e)}`;
  }
};

describe("a read-only actor (view as customer)", () => {
  it("is the owner's view of the org, marked read-only", () => {
    expect(viewAsActor({ userId: "u", orgId: "o" })).toEqual({
      userId: "u",
      orgId: "o",
      role: "owner",
      workspaceIds: "all",
      surface: "ui",
      actorType: "user",
      readOnly: true,
    });
  });

  it("authorizeAction refuses every write action in the registry and allows the owner's reads", () => {
    const actor = ro("u", "o");
    let refused = 0;
    let allowed = 0;
    const surprises: string[] = [];
    for (const a of actions) {
      const got = attempt(() => authorizeAction(actor, a));
      if (a.kind === "write") {
        if (got === "read-only") refused++;
        else surprises.push(`${a.name}: write was ${got}`);
      } else if (READ_ONLY_REFUSED_READS.has(a.name)) {
        if (got !== "read-only") surprises.push(`${a.name}: listed read was ${got}`);
      } else if (!roleHasPermission("owner", a.permission)) {
        continue; // a read the owner role itself may not run (kept out of both counts)
      } else if (got === "allowed") allowed++;
      else surprises.push(`${a.name}: read was ${got}`);
    }
    console.log(`[view-as] ${refused} write actions refused, ${allowed} read actions allowed`);
    expect(surprises).toEqual([]);
    expect(refused).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
    expect(refused).toBe(actions.filter((a) => a.kind === "write").length);
  });

  it("the refused-read list names real read actions (canary: a rename must not silently drop a guard)", () => {
    expect(READ_ONLY_REFUSED_READS.size).toBeGreaterThan(0);
    for (const n of READ_ONLY_REFUSED_READS) {
      const a = actions.find((x) => x.name === n);
      expect(a, n).toBeDefined();
      expect(a!.kind, n).toBe("read");
    }
  });

  it("the refusal carries the plain message and a FORBIDDEN code", () => {
    const write = actions.find((a) => a.kind === "write")!;
    try {
      authorizeAction(ro("u", "o"), write);
      throw new Error("not refused");
    } catch (e) {
      expect(e).toMatchObject({ code: "FORBIDDEN", message: READ_ONLY_VIEW_MESSAGE, view: "READ_ONLY_VIEW" });
    }
  });

  it("running a write action writes nothing (renaming a client leaves the row alone)", async () => {
    const o = await kit.makeOrg();
    const before = (await db.select().from(workspaces).where(eq(workspaces.id, o.a)))[0]!;
    const viewer = ro(o.ownerId, o.orgId);
    await expect(executeAction(db, viewer, "workspaces.rename", { workspaceId: o.a, name: "Hacked" })).rejects.toBeInstanceOf(ReadOnlyViewError);
    await expect(executeToolCall(db, viewer, "workspaces.rename", { workspaceId: o.a, name: "Hacked" })).rejects.toBeInstanceOf(ReadOnlyViewError);
    const write = actions.find((a) => a.name === "workspaces.rename")!;
    // Callers that arrive with an already authorized action (proposal apply) hit the executor's own guard.
    await expect(runParsed(db, viewer, write, { workspaceId: o.a, name: "Hacked" })).rejects.toBeInstanceOf(ReadOnlyViewError);
    const after = (await db.select().from(workspaces).where(eq(workspaces.id, o.a)))[0]!;
    expect(after.name).toBe(before.name);
    // The real owner can still rename it (the guard is the actor, not the action).
    await executeAction(db, o.owner, "workspaces.rename", { workspaceId: o.a, name: `${before.name} 2` });
    expect((await db.select().from(workspaces).where(eq(workspaces.id, o.a)))[0]!.name).toBe(`${before.name} 2`);
  });

  it("reads still work for the read-only actor", async () => {
    const o = await kit.makeOrg();
    const out = (await executeAction(db, ro(o.ownerId, o.orgId), "workspaces.list", {})) as { workspaces: { id: string }[] };
    expect(out.workspaces.map((w) => w.id)).toEqual(expect.arrayContaining([o.a, o.b]));
  });

  it("a READ action whose handler writes fails for a read-only actor (database guard) and succeeds for the owner", async () => {
    const o = await kit.makeOrg();
    const sneaky = defineAction({
      name: "test.sneakyRead",
      description: "test only",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      permission: "workspace:read",
      kind: "read",
      async handler({ tx, actor }) {
        await tx.insert(workspaces).values({ orgId: actor.orgId, name: `sneaky ${Math.random()}` });
        return { ok: true };
      },
    });
    const count = async () => (await db.select().from(workspaces).where(eq(workspaces.orgId, o.orgId))).length;
    const start = await count();
    const err = await executeAction(db, ro(o.ownerId, o.orgId), "test.sneakyRead", {}, [sneaky]).catch((e) => e);
    expect(String((err as { cause?: Error }).cause?.message ?? err)).toMatch(/read-only transaction/);
    expect(await count()).toBe(start);
    await executeAction(db, o.owner, "test.sneakyRead", {}, [sneaky]);
    expect(await count()).toBe(start + 1);
  });

  it("a Google read that finds access denied does not record that on the location", async () => {
    const o = await kit.makeOrg();
    const { row } = await o.mkLoc(o.a);
    const denied = new GoogleApiError(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } });
    const original = mock.listPlaceActionLinks.bind(mock);
    mock.listPlaceActionLinks = async () => {
      throw denied;
    };
    const marks = () => db.select().from(locationDataAccess).where(eq(locationDataAccess.locationId, row.id));
    try {
      const seen = (await executeAction(db, ro(o.ownerId, o.orgId), "placeActions.list", { locationId: row.id })) as { googleAccessDenied: boolean };
      expect(seen.googleAccessDenied).toBe(true); // the page still tells the truth
      expect(await marks()).toHaveLength(0);
      await executeAction(db, o.owner, "placeActions.list", { locationId: row.id });
      expect(await marks()).toHaveLength(1); // the owner's own read does record it (unchanged behaviour)
    } finally {
      mock.listPlaceActionLinks = original;
    }
  });

  it("the chat assistant (it spends AI budget) is refused", async () => {
    const o = await kit.makeOrg();
    await expect(
      runAssistantTurn(db, ro(o.ownerId, o.orgId), { workspaceId: o.a, messages: [{ role: "user", text: "hi" }] }),
    ).rejects.toBeInstanceOf(ReadOnlyViewError);
  });
});
