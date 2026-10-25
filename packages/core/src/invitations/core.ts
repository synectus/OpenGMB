import type { Tx } from "@opengmb/db";

/** Community edition: one owner, nobody is invited. Client roles are still recognised. */
export const INVITE_COOKIE = "invite";

export { isClientRole } from "../client-role";

export const inviteTokenFromCookie = (_cookieHeader: string | null | undefined): string | null => null;

export async function bindInvitationForSignUp(_tx: Tx, _userId: string, _token: string): Promise<void> {}

export async function invitationCount(_tx: Tx, _orgId: string): Promise<number> {
  return 0;
}
