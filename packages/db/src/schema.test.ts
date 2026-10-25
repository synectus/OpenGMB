import { afterAll, describe, expect, it } from "vitest";
import { createDb, memberships, organizations, users, workspaces } from "./index";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

async function fixture() {
  const [org] = await db.insert(organizations).values({ name: "o" }).returning();
  const [ws] = await db.insert(workspaces).values({ orgId: org!.id, name: "w" }).returning();
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, name: "u", email: `${id}@example.test` });
  return { orgId: org!.id, workspaceId: ws!.id, userId: id };
}

describe("memberships constraints", () => {
  it("rejects a client role without workspace_id", async () => {
    const f = await fixture();
    await expect(
      db.insert(memberships).values({ orgId: f.orgId, userId: f.userId, role: "client_viewer" }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/memberships_workspace_iff_client_role/) },
    });
  });

  it("rejects a staff role with workspace_id", async () => {
    const f = await fixture();
    await expect(
      db
        .insert(memberships)
        .values({ orgId: f.orgId, userId: f.userId, role: "manager", workspaceId: f.workspaceId }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/memberships_workspace_iff_client_role/) },
    });
  });

  it("accepts valid rows and treats null workspace as not distinct", async () => {
    const f = await fixture();
    await db.insert(memberships).values({ orgId: f.orgId, userId: f.userId, role: "owner" });
    await db.insert(memberships).values({
      orgId: f.orgId,
      userId: f.userId,
      role: "client_viewer",
      workspaceId: f.workspaceId,
    });
    await expect(
      db.insert(memberships).values({ orgId: f.orgId, userId: f.userId, role: "admin" }),
    ).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/memberships_org_user_workspace_unique/) },
    });
  });
});
