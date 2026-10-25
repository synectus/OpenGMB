import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { accounts, memberships, organizations, users, type Db } from "@opengmb/db";
import { writeAudit } from "./audit";

type Env = Record<string, string | undefined>;
export type BootstrapResult = "created" | "exists" | "missing-env" | "invalid-env";

/** Better-Auth refuses passwords outside this range. */
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const DEFAULT_ORG_NAME = "My agency";
/** Serialises concurrent starts: one transaction at a time decides whether the organization exists. */
const LOCK_KEY = "owner-bootstrap";

/**
 * First start of a self-hosted instance: when the database has no organization and OWNER_EMAIL and
 * OWNER_PASSWORD are set, creates the organization, its owner (email already verified) and the owner
 * membership. Once any organization exists this does nothing, so the owner changes the password in the
 * app and the env value is ignored from then on. The password is never logged.
 */
export async function bootstrapOwner(db: Db, env: Env = process.env): Promise<BootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
    const [org] = await tx.select({ id: organizations.id }).from(organizations).limit(1);
    if (org) return "exists";

    const email = env.OWNER_EMAIL?.trim().toLowerCase();
    const password = env.OWNER_PASSWORD;
    if (!email || !password) {
      console.log("[bootstrap] No organization yet: set OWNER_EMAIL and OWNER_PASSWORD and restart to create the owner account.");
      return "missing-env";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      console.log(`[bootstrap] OWNER_EMAIL must be an email address and OWNER_PASSWORD ${MIN_PASSWORD} to ${MAX_PASSWORD} characters; no account was created.`);
      return "invalid-env";
    }

    const userId = randomBytes(16).toString("hex");
    await tx.insert(users).values({ id: userId, name: email.split("@")[0]!, email, emailVerified: true });
    await tx.insert(accounts).values({
      id: randomBytes(16).toString("hex"),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    });
    const [created] = await tx
      .insert(organizations)
      .values({ name: env.OWNER_ORG_NAME?.trim() || DEFAULT_ORG_NAME })
      .returning();
    const [membership] = await tx.insert(memberships).values({ orgId: created!.id, userId, role: "owner" }).returning();
    const actor = { orgId: created!.id, actorUserId: userId, actorType: "user", surface: "cli" } as const;
    await writeAudit(tx, { ...actor, action: "organization.create", entityType: "organization", entityId: created!.id, before: null, after: created });
    await writeAudit(tx, { ...actor, action: "membership.create", entityType: "membership", entityId: membership!.id, before: null, after: membership });
    console.log("[bootstrap] Created the organization and its owner from OWNER_EMAIL.");
    return "created";
  });
}
