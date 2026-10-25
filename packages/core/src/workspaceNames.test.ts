import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, memberships, users, workspaceReplySettings, workspaces } from "@opengmb/db";
import { MockGoogleClient } from "./google/mock-client";
import { codeOf, makeKit, uniq, type Org } from "./testkit";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const kit = makeKit(db, new MockGoogleClient());
const { run } = kit;
let org: Org;
beforeAll(async () => {
  org = await kit.makeOrg();
});
afterAll(async () => {
  await kit.deactivateAll();
  await sql.end();
});

type Out = { workspace: { id: string; name: string } };
const mk = async (name: string) => (await run<Out>(org.owner, "workspaces.create", { name })).workspace;

describe("client names (U3)", () => {
  it("create refuses a name that differs only in case or padding", async () => {
    const n = `Case ${uniq()}`;
    await mk(n);
    expect(await codeOf(run(org.owner, "workspaces.create", { name: n.toLowerCase() }))).toBe("CONFLICT");
    expect(await codeOf(run(org.owner, "workspaces.create", { name: n.toUpperCase() }))).toBe("CONFLICT");
    expect(await codeOf(run(org.owner, "workspaces.create", { name: `  ${n}  ` }))).toBe("CONFLICT");
  });

  it("rename changes the name and audits it", async () => {
    const w = await mk(`Old ${uniq()}`);
    const next = `New ${uniq()}`;
    const out = await run<Out>(org.owner, "workspaces.rename", { workspaceId: w.id, name: `  ${next}  ` });
    expect(out.workspace.name).toBe(next);
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, w.id));
    expect(row!.name).toBe(next);
    const audits = (await kit.auditRows(org.orgId, "workspace.rename")).filter((r) => r.entityId === w.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toEqual({ name: w.name });
  });

  it("rename refuses another client's name in any case, but lets a client change its own casing", async () => {
    const a = await mk(`Alpha ${uniq()}`);
    const b = await mk(`Beta ${uniq()}`);
    expect(await codeOf(run(org.owner, "workspaces.rename", { workspaceId: b.id, name: a.name.toUpperCase() }))).toBe(
      "CONFLICT",
    );
    const recased = a.name.toLowerCase();
    const out = await run<Out>(org.owner, "workspaces.rename", { workspaceId: a.id, name: recased });
    expect(out.workspace.name).toBe(recased);
  });

  it("rename needs owner or admin and stays inside the organization", async () => {
    const w = await mk(`Perm ${uniq()}`);
    expect(await codeOf(run(org.manager, "workspaces.rename", { workspaceId: w.id, name: "x" }))).toBe("FORBIDDEN");
    expect(await codeOf(run(org.viewerA, "workspaces.delete", { workspaceId: w.id }))).toBe("FORBIDDEN");
    const other = await kit.makeOrg();
    expect(await codeOf(run(other.owner, "workspaces.rename", { workspaceId: w.id, name: "x" }))).toBe("NOT_FOUND");
    expect(await codeOf(run(other.owner, "workspaces.delete", { workspaceId: w.id }))).toBe("NOT_FOUND");
  });

  it("delete removes an empty client and audits it", async () => {
    const w = await mk(`Gone ${uniq()}`);
    expect(await run(org.owner, "workspaces.delete", { workspaceId: w.id })).toEqual({ deleted: true });
    expect(await db.select().from(workspaces).where(eq(workspaces.id, w.id))).toHaveLength(0);
    expect((await kit.auditRows(org.orgId, "workspace.delete")).filter((r) => r.entityId === w.id)).toHaveLength(1);
  });

  it("delete is refused while the client has locations, and changes nothing", async () => {
    const w = await mk(`Busy ${uniq()}`);
    await org.mkLoc(w.id);
    await expect(run(org.owner, "workspaces.delete", { workspaceId: w.id })).rejects.toThrow(/location/);
    expect(await codeOf(run(org.owner, "workspaces.delete", { workspaceId: w.id }))).toBe("CONFLICT");
    expect(await db.select().from(workspaces).where(eq(workspaces.id, w.id))).toHaveLength(1);
  });

  it("delete is refused while people belong to the client", async () => {
    const w = await mk(`People ${uniq()}`);
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId: org.orgId, userId: id, role: "client_viewer", workspaceId: w.id });
    expect(await codeOf(run(org.owner, "workspaces.delete", { workspaceId: w.id }))).toBe("CONFLICT");
    expect(await db.select().from(workspaces).where(eq(workspaces.id, w.id))).toHaveLength(1);
  });

  it("delete also removes the client's reply settings row", async () => {
    const w = await mk(`Settings ${uniq()}`);
    await db.insert(workspaceReplySettings).values({ orgId: org.orgId, workspaceId: w.id });
    expect(await run(org.owner, "workspaces.delete", { workspaceId: w.id })).toEqual({ deleted: true });
    expect(await db.select().from(workspaceReplySettings).where(eq(workspaceReplySettings.workspaceId, w.id))).toHaveLength(0);
  });
});
