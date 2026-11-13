import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { memberships, verifications, type Db } from "@opengmb/db";

/** Matches no consent: a person with several organizations, or none, always sees the consent page. */
export const UNCHOSEN_ORG = "unchosen";
/** As long as the signed authorize request (codeExpiresIn, 600 s). */
const CHOICE_TTL_MS = 10 * 60 * 1000;

const key = (sessionId: string) => `oauth-org:${sessionId}`;

export async function rememberOrgChoice(db: Db, sessionId: string, orgId: string, now = new Date()) {
  await db.delete(verifications).where(eq(verifications.identifier, key(sessionId)));
  await db.insert(verifications).values({
    id: randomUUID(),
    identifier: key(sessionId),
    value: orgId,
    expiresAt: new Date(now.getTime() + CHOICE_TTL_MS),
  });
}

export async function clearOrgChoice(db: Db, sessionId: string) {
  await db.delete(verifications).where(eq(verifications.identifier, key(sessionId)));
}

/** True when the consent page stored an account choice for this session; the consent hook in provider.ts refuses accept without one. */
export async function hasOrgChoice(db: Db, sessionId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(and(eq(verifications.identifier, key(sessionId)), gt(verifications.expiresAt, now)))
    .limit(1);
  return Boolean(row);
}

/** The plugin's postLogin.consentReferenceId: the organization a consent and its tokens belong to. Never undefined. */
export async function consentReference(db: Db, input: { userId: string; sessionId: string }, now = new Date()): Promise<string> {
  const [chosen] = await db
    .select({ orgId: verifications.value })
    .from(verifications)
    .where(and(eq(verifications.identifier, key(input.sessionId)), gt(verifications.expiresAt, now)))
    .limit(1);
  if (chosen) return chosen.orgId;
  const rows = await db.selectDistinct({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, input.userId));
  return rows.length === 1 ? rows[0]!.orgId : UNCHOSEN_ORG;
}
