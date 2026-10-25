import { nextCookies } from "better-auth/next-js";
import {
  countBackupCodes,
  createAuth,
  getActorContext,
  hasCredentialPassword,
  isGoogleConfigured,
  loadActor,
} from "@opengmb/core";
import { createDb } from "@opengmb/db";

// One pool and one auth instance per server process (survives dev hot reloads).
// Built lazily so `next build` does not need a database.
type Instance = { db: ReturnType<typeof createDb>["db"]; auth: ReturnType<typeof createAuth> };
const g = globalThis as unknown as { __syngmb?: Instance };

function instance(): Instance {
  if (!g.__syngmb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const { db } = createDb(url);
    g.__syngmb = { db, auth: createAuth(db, { plugins: [nextCookies()] }) };
  }
  return g.__syngmb;
}

export const getAuth = () => instance().auth;
export const getDb = () => instance().db;
export const googleEnabled = () => isGoogleConfigured();
export const userHasPassword = (userId: string) => hasCredentialPassword(instance().db, userId);

export async function actorContextFor(userId: string) {
  const { db } = instance();
  const actor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
  return getActorContext(db, actor);
}

/** Unused backup codes for a signed-in user. Only the number leaves the server. */
export const backupCodesLeft = (userId: string) => countBackupCodes(instance().auth, userId);
