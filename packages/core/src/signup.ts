/** Accounts are never created through the API; the owner comes from owner-bootstrap.ts. Same exports as the full module. */
import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { memberships, type Tx } from "@opengmb/db";

export const signupEnabled = (): boolean => false;

export const signupMode = (_env?: Record<string, string | undefined>): string => "closed";

/** Runs when an account row is created. Only someone who already belongs to an organization passes (a new sign-in method). */
export async function provisionAccount(
  tx: Tx,
  userId: string,
  _cookieHeader: string | null | undefined,
  _afterInsert?: (tx: Tx, userId: string) => Promise<void>,
): Promise<void> {
  const [member] = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, userId)).limit(1);
  if (!member) throw new APIError("FORBIDDEN", { message: "Sign-up is disabled on this server" });
}
