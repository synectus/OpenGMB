"use server";
import { headers } from "next/headers";
import { AuthError, requireAuthenticatedUser } from "@opengmb/core";
import { backupCodesLeft, getAuth } from "../../../lib/auth";

/**
 * Backup codes the now signed-in user has left, or null without a full session. Only the number
 * leaves the server; the codes never do.
 */
export async function backupCodesLeftAction(): Promise<number | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  try {
    const { userId } = requireAuthenticatedUser(session);
    return await backupCodesLeft(userId);
  } catch (e) {
    if (e instanceof AuthError) return null;
    throw e;
  }
}
