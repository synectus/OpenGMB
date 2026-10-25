import { and, eq } from "drizzle-orm";
import { googleConnections, memberships, users, type Db, type Tx } from "@opengmb/db";
import { writeAudit } from "../audit";
import { encryptSecret } from "../crypto";
import { CoreError } from "../errors";

export const MOCK_GOOGLE_EMAIL = "mock-google@example.test";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/business.manage"];

/**
 * Dev only: gives a user's organization a fake Google connection so the mock client can be used
 * without OAuth. Refuses unless GOOGLE_BUSINESS_API_MODE is `mock` (or unset, which means mock).
 * Idempotent: a second run reuses the existing mock connection and writes nothing.
 */
export const isMockGoogleMode = (): boolean => (process.env.GOOGLE_BUSINESS_API_MODE?.trim() || "mock") === "mock";

export async function seedMockGoogleConnection(
  db: Db,
  email: string,
): Promise<{ connectionId: string; orgId: string; created: boolean }> {
  const mode = process.env.GOOGLE_BUSINESS_API_MODE?.trim() || "mock";
  if (mode !== "mock") {
    throw new CoreError(
      "NOT_CONFIGURED",
      `Refusing to seed a fake Google connection: GOOGLE_BUSINESS_API_MODE is "${mode}", not "mock"`,
    );
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) throw new CoreError("NOT_FOUND", `No user with email ${email}`);
  const orgIds = [
    ...new Set(
      (
        await db
          .select({ orgId: memberships.orgId })
          .from(memberships)
          .where(eq(memberships.userId, user.id))
      ).map((m) => m.orgId),
    ),
  ];
  if (orgIds.length !== 1) {
    throw new CoreError(
      "INVALID_INPUT",
      `${email} must belong to exactly one organization (found ${orgIds.length})`,
    );
  }
  const orgId = orgIds[0]!;

  return db.transaction(async (tx) => {
    const r = await insertMockGoogleConnection(tx, orgId, user.id);
    if (r.created) {
      await writeAudit(tx, {
        orgId,
        actorUserId: user.id,
        actorType: "user",
        surface: "cli",
        action: "google_connection.dev_seed",
        entityType: "google_connection",
        entityId: r.connectionId,
        before: null,
        after: MOCK_AUDIT_AFTER,
      });
    }
    return { ...r, orgId };
  });
}

export const MOCK_AUDIT_AFTER = { googleAccountEmail: MOCK_GOOGLE_EMAIL, scopes: SCOPES, mock: true };

/** The organization's fake Google connection: reuses the existing one, else inserts it. The caller checks the mode and audits. */
export async function insertMockGoogleConnection(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<{ connectionId: string; created: boolean }> {
  const [existing] = await tx
    .select({ id: googleConnections.id })
    .from(googleConnections)
    .where(
      and(
        eq(googleConnections.orgId, orgId),
        eq(googleConnections.googleAccountEmail, MOCK_GOOGLE_EMAIL),
      ),
    );
  if (existing) return { connectionId: existing.id, created: false };
  const [row] = await tx
    .insert(googleConnections)
    .values({
      orgId,
      userId,
      googleAccountId: `mock-${crypto.randomUUID()}`,
      googleAccountEmail: MOCK_GOOGLE_EMAIL,
      refreshTokenEnc: encryptSecret("mock-refresh-token"),
      scopes: SCOPES,
    })
    .returning();
  return { connectionId: row!.id, created: true };
}
