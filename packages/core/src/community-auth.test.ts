import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, memberships, organizations, users } from "@opengmb/db";
import { eq } from "drizzle-orm";
import { createAuth } from "./auth";
import { originForUser, orgForHost } from "./custom-domains";
import { isCommunity } from "./edition";
import { provisionAccount, signupEnabled } from "./signup";

/** Community edition only: accounts come from the owner bootstrap, never from the API. Skipped (and shown as skipped) in the full server. */
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const usersWithEmail = async (email: string) => (await db.select({ id: users.id }).from(users).where(eq(users.email, email))).length;

describe.skipIf(!isCommunity())("community sign-in only", () => {
  it("the sign-up endpoint is refused and creates no user", async () => {
    expect(signupEnabled()).toBe(false);
    const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: BASE });
    const email = `${randomUUID()}@example.test`;
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ name: "Nobody", email, password: "long-enough-password" }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Other test files create users in the same database at the same time: look at this email only.
    expect(await usersWithEmail(email)).toBe(0);
  });

  it("a new account row is refused for someone with no organization and allowed for a member", async () => {
    const stranger = randomUUID();
    const member = randomUUID();
    await db.insert(users).values([
      { id: stranger, name: "Stranger", email: `${stranger}@example.test` },
      { id: member, name: "Member", email: `${member}@example.test` },
    ]);
    const [org] = await db.insert(organizations).values({ name: "Test org" }).returning();
    await db.insert(memberships).values({ orgId: org!.id, userId: member, role: "owner" });
    await expect(db.transaction((tx) => provisionAccount(tx, stranger, null))).rejects.toThrow(/disabled/i);
    await expect(db.transaction((tx) => provisionAccount(tx, member, null))).resolves.toBeUndefined();
  });

  it("no host maps to an organization and links use the instance's own address", async () => {
    expect(await orgForHost(db, "agency.example.test", BASE)).toBeNull();
    expect(await originForUser(db, randomUUID(), BASE)).toBe(BASE);
  });
});
