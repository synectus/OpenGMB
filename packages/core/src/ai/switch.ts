import { eq } from "drizzle-orm";
import { organizations, type Db, type Tx } from "@opengmb/db";
import { CoreError } from "../errors";

/** The one message every refused AI action shows. Plain words, no code. */
export const AI_OFF_MESSAGE = "AI features are switched off for this account. An owner can turn them on in Settings, Billing.";

/** True unless an owner switched AI features off for the whole account. */
export async function aiEnabledForOrg(db: Db | Tx, orgId: string): Promise<boolean> {
  const [o] = await db.select({ off: organizations.aiDisabledAt }).from(organizations).where(eq(organizations.id, orgId));
  return o?.off == null;
}

/**
 * Call before any request that would send content to Anthropic or OpenAI. Throws when the account switch is off,
 * so nothing leaves the server. Every AI path in core calls this before its model call.
 */
export async function assertAiEnabled(db: Db | Tx, orgId: string): Promise<void> {
  if (!(await aiEnabledForOrg(db, orgId))) throw new CoreError("CONFLICT", AI_OFF_MESSAGE);
}
