import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  locations,
  memberships,
  notifications,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { executeAction } from "./executor";
import { googleNotificationContent, recipientsForLocation } from "./notifications";
import type { Role } from "./permissions";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function world() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const [other] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const [wsA] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `a-${uniq()}` })
    .returning();
  const [wsB] = await db
    .insert(workspaces)
    .values({ orgId: org!.id, name: `b-${uniq()}` })
    .returning();
  const [loc] = await db
    .insert(locations)
    .values({ orgId: org!.id, workspaceId: wsA!.id, name: "Houston Clinic" })
    .returning();
  const mk = async (role: Role, orgId: string, workspaceId: string | null) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return id;
  };
  return { org: org!.id, other: other!.id, wsA: wsA!.id, wsB: wsB!.id, loc: loc!.id, mk };
}

describe("recipientsForLocation", () => {
  it("org-wide roles and clients of the location's workspace only", async () => {
    const w = await world();
    const owner = await w.mk("owner", w.org, null);
    const admin = await w.mk("admin", w.org, null);
    const manager = await w.mk("manager", w.org, null);
    const clientA = await w.mk("client_viewer", w.org, w.wsA);
    const approverA = await w.mk("client_approver", w.org, w.wsA);
    await w.mk("client_viewer", w.org, w.wsB);
    await w.mk("owner", w.other, null);
    const got = await db.transaction((tx) => recipientsForLocation(tx, w.org, w.loc));
    expect(got).toEqual([owner, admin, manager, clientA, approverA].sort());
  });

  it("unknown location, or one from another org, has no recipients", async () => {
    const w = await world();
    await w.mk("owner", w.org, null);
    expect(
      await db.transaction((tx) => recipientsForLocation(tx, w.org, crypto.randomUUID())),
    ).toEqual([]);
    expect(await db.transaction((tx) => recipientsForLocation(tx, w.other, w.loc))).toEqual([]);
  });

  it("a user with both org-wide and client memberships appears once", async () => {
    const w = await world();
    const u = await w.mk("manager", w.org, null);
    await db
      .insert(memberships)
      .values({ orgId: w.org, userId: u, role: "client_viewer", workspaceId: w.wsA });
    expect(await db.transaction((tx) => recipientsForLocation(tx, w.org, w.loc))).toEqual([u]);
  });
});

describe("googleNotificationContent", () => {
  it("builds titles from type and location name", () => {
    expect(googleNotificationContent("NEW_REVIEW", "X")).toEqual({
      kind: "google.new_review",
      title: "New review at X",
    });
    expect(googleNotificationContent("UPDATED_REVIEW", "X").title).toBe("Updated review at X");
    expect(googleNotificationContent("GOOGLE_UPDATE", "X")).toEqual({
      kind: "google.google_update",
      title: "Google suggested an edit to X",
    });
  });
});

describe("notifications.list / markRead", () => {
  async function setup() {
    const w = await world();
    const me = await w.mk("manager", w.org, null);
    const them = await w.mk("owner", w.org, null);
    const stranger = await w.mk("owner", w.other, null);
    const mkN = async (userId: string, orgId: string, i: number, read = false) => {
      const [r] = await db
        .insert(notifications)
        .values({
          orgId,
          userId,
          kind: "google.new_review",
          title: `n${i}`,
          sourceType: "t",
          sourceId: `${uniq()}-${i}`,
          createdAt: new Date(Date.now() - i * 1000),
          readAt: read ? new Date() : null,
        })
        .returning();
      return r!.id;
    };
    const mine = [await mkN(me, w.org, 1), await mkN(me, w.org, 2), await mkN(me, w.org, 3, true)];
    const theirs = await mkN(them, w.org, 1);
    const foreign = await mkN(stranger, w.other, 1);
    const actor = await loadActor(db, { userId: me, surface: "ui", actorType: "user" });
    return { w, me, mine, theirs, foreign, actor };
  }

  it("lists only the caller's own, newest first, with unreadCount", async () => {
    const { actor, mine } = await setup();
    const out = (await executeAction(db, actor, "notifications.list", {})) as {
      unreadCount: number;
      items: { id: string; title: string }[];
    };
    expect(out.unreadCount).toBe(2);
    expect(out.items.map((i) => i.id)).toEqual(mine);
    const unread = (await executeAction(db, actor, "notifications.list", {
      unreadOnly: true,
      limit: 1,
    })) as typeof out;
    expect(unread.items.map((i) => i.id)).toEqual([mine[0]]);
    expect(unread.unreadCount).toBe(2);
  });

  it("rejects limit out of range", async () => {
    const { actor } = await setup();
    await expect(
      executeAction(db, actor, "notifications.list", { limit: 101 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      executeAction(db, actor, "notifications.list", { limit: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("markRead ignores other users' and other orgs' ids and audits", async () => {
    const { actor, mine, theirs, foreign, w } = await setup();
    const out = await executeAction(db, actor, "notifications.markRead", {
      ids: [mine[0]!, theirs, foreign, crypto.randomUUID()],
    });
    expect(out).toEqual({ updated: 1 });
    const [t] = await db.select().from(notifications).where(eq(notifications.id, theirs));
    expect(t!.readAt).toBeNull();
    const [f] = await db.select().from(notifications).where(eq(notifications.id, foreign));
    expect(f!.readAt).toBeNull();
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, w.org), eq(auditLog.action, "notification.mark_read")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toEqual({ count: 1, ids: [mine[0]] });
    expect(audit[0]!.entityId).toBe(actor.userId);
  });

  it("markRead all marks only the caller's unread", async () => {
    const { actor, theirs, w } = await setup();
    expect(await executeAction(db, actor, "notifications.markRead", { all: true })).toEqual({
      updated: 2,
    });
    const [t] = await db.select().from(notifications).where(eq(notifications.id, theirs));
    expect(t!.readAt).toBeNull();
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, w.org), eq(auditLog.action, "notification.mark_read")));
    expect(audit[0]!.after).toEqual({ count: 2, ids: "all" });
    expect(await executeAction(db, actor, "notifications.list", {})).toMatchObject({
      unreadCount: 0,
    });
  });

  it("markRead needs exactly one of ids or all, ids max 100", async () => {
    const { actor } = await setup();
    for (const bad of [
      {},
      { ids: [crypto.randomUUID()], all: true },
      { ids: [] },
      { all: false },
      { ids: ["nope"] },
    ]) {
      await expect(executeAction(db, actor, "notifications.markRead", bad)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
    const many = Array.from({ length: 101 }, () => crypto.randomUUID());
    await expect(
      executeAction(db, actor, "notifications.markRead", { ids: many }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("every role may use them (client roles included)", async () => {
    const w = await world();
    const u = await w.mk("client_viewer", w.org, w.wsA);
    const actor: Actor = await loadActor(db, { userId: u, surface: "ui", actorType: "user" });
    expect(await executeAction(db, actor, "notifications.list", {})).toMatchObject({
      unreadCount: 0,
    });
    expect(await executeAction(db, actor, "notifications.markRead", { all: true })).toEqual({
      updated: 0,
    });
  });
});
