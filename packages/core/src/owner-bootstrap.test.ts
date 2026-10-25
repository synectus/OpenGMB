import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, auditLog, createDb, type Db, memberships, organizations, users } from "@opengmb/db";
import { runMigrations } from "../../db/src/migrate";
import { eq } from "drizzle-orm";
import { createAuth } from "./auth";
import { bootstrapOwner } from "./owner-bootstrap";

/**
 * Needs an EMPTY database, which the shared test database never is while other files run, so this file
 * migrates a throwaway database of its own on the same server and drops it afterwards.
 */
const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) throw new Error("DATABASE_URL_TEST is not set");
const scratchName = `boot_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const urlFor = (name: string) => {
  const u = new URL(testUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const admin = createDb(urlFor("postgres")).sql;
let db: ReturnType<typeof createDb>["db"];
let client: ReturnType<typeof createDb>["sql"];

/** Another empty, migrated database for one test. */
async function withScratchDb(run: (db: Db) => Promise<void>) {
  const name = `boot_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const extra = await migratedClient(name);
  try {
    await run(extra.db);
  } finally {
    await extra.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}
async function migratedClient(name: string) {
  await runMigrations(urlFor(name));
  return createDb(urlFor(name));
}

const PASSWORD = "correct-horse-battery";
const env = { OWNER_EMAIL: "Owner@Example.test", OWNER_PASSWORD: PASSWORD, OWNER_ORG_NAME: "Main Street Agency" };

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${scratchName}`);
  ({ db, sql: client } = await migratedClient(scratchName));
});
afterAll(async () => {
  await client.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
  await admin.end();
});
afterEach(() => vi.restoreAllMocks());

const counts = async () => ({
  orgs: (await db.select().from(organizations)).length,
  users: (await db.select().from(users)).length,
  owners: (await db.select().from(memberships).where(eq(memberships.role, "owner"))).length,
  accounts: (await db.select().from(accounts)).length,
});

function captureLogs() {
  const lines: string[] = [];
  for (const m of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  }
  return lines;
}

describe("bootstrapOwner", () => {
  it("missing env creates nothing and logs one hint line without any value", async () => {
    const lines = captureLogs();
    expect(await bootstrapOwner(db, {})).toBe("missing-env");
    expect(await bootstrapOwner(db, { OWNER_EMAIL: "a@example.test" })).toBe("missing-env");
    expect(await counts()).toEqual({ orgs: 0, users: 0, owners: 0, accounts: 0 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("OWNER_EMAIL");
    expect(lines.join("\n")).not.toContain("a@example.test");
  });

  it("a password Better-Auth would refuse creates nothing", async () => {
    captureLogs();
    expect(await bootstrapOwner(db, { OWNER_EMAIL: "a@example.test", OWNER_PASSWORD: "short" })).toBe("invalid-env");
    expect(await bootstrapOwner(db, { OWNER_EMAIL: "not-an-email", OWNER_PASSWORD: PASSWORD })).toBe("invalid-env");
    expect(await counts()).toEqual({ orgs: 0, users: 0, owners: 0, accounts: 0 });
  });

  it("empty database + env creates exactly one organization, one verified user and one owner membership", async () => {
    const lines = captureLogs();
    expect(await bootstrapOwner(db, env)).toBe("created");
    expect(await counts()).toEqual({ orgs: 1, users: 1, owners: 1, accounts: 1 });
    const [org] = await db.select().from(organizations);
    expect(org!.name).toBe("Main Street Agency");
    const [user] = await db.select().from(users);
    expect(user!.email).toBe("owner@example.test");
    expect(user!.emailVerified).toBe(true);
    const audit = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.orgId, org!.id));
    expect(audit.map((a) => a.action).sort()).toEqual(["membership.create", "organization.create"]);
    expect(lines.join("\n")).not.toContain(PASSWORD);
  });

  it("the created owner can sign in with the env password", async () => {
    const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: "http://localhost:3000" });
    const ok = await auth.api.signInEmail({ body: { email: "owner@example.test", password: PASSWORD } });
    expect(ok.user.email).toBe("owner@example.test");
    await expect(auth.api.signInEmail({ body: { email: "owner@example.test", password: "wrong-password-here" } })).rejects.toThrow();
  });

  it("a second start creates nothing, and an existing organization ignores a different env password", async () => {
    const [before] = await db.select({ p: accounts.password }).from(accounts);
    expect(await bootstrapOwner(db, env)).toBe("exists");
    expect(await bootstrapOwner(db, { ...env, OWNER_EMAIL: "other@example.test", OWNER_PASSWORD: "another-long-password" })).toBe("exists");
    expect(await counts()).toEqual({ orgs: 1, users: 1, owners: 1, accounts: 1 });
    const [after] = await db.select({ p: accounts.password }).from(accounts);
    expect(after!.p).toBe(before!.p);
  });

  it("two starts at once still create one organization", async () => {
    await withScratchDb(async (db2) => {
      captureLogs();
      const results = await Promise.all([bootstrapOwner(db2, env), bootstrapOwner(db2, env), bootstrapOwner(db2, env)]);
      expect(results.filter((r) => r === "created")).toHaveLength(1);
      expect((await db2.select().from(organizations)).length).toBe(1);
    });
  });

  it("OWNER_ORG_NAME defaults to My agency", async () => {
    await withScratchDb(async (db2) => {
      captureLogs();
      await bootstrapOwner(db2, { OWNER_EMAIL: "x@example.test", OWNER_PASSWORD: PASSWORD });
      expect((await db2.select().from(organizations))[0]!.name).toBe("My agency");
    });
  });
});
