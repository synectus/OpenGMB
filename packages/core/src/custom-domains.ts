/** One address per instance (BETTER_AUTH_URL). Same exports as the full module: no per-organization hosts. */
import { eq } from "drizzle-orm";
import { memberships, type Db, type Tx } from "@opengmb/db";
import type { Branding } from "./branding";
import { emailFrom } from "./email";

type Conn = Db | Tx;
type Base = string | undefined;
const mainOrigin = (base: Base = process.env.BETTER_AUTH_URL) => base ?? "";

export const BRAND_LOGO_PATH = "/api/brand/logo";
export const orgForHost = async (_db: Conn, _host: string, _base?: Base): Promise<string | null> => null;
export const customOriginFor = (_host: string, base: string): string => base;
export const trustedCustomOrigins = async (_db: Conn, _base: Base): Promise<string[]> => [];
export const originForRole = async (_db: Conn, _orgId: string, _role: string, base?: Base) => mainOrigin(base);
export const originForUser = async (_db: Conn, _userId: string, base?: Base) => mainOrigin(base);
export const emailFromFor = async (_db: Conn, _orgId: string) => emailFrom();
export const emailFromForUser = async (_db: Conn, _userId: string) => emailFrom();
export const hostBranding = async (_db: Conn, _host: string, _base?: Base): Promise<(Branding & { orgId: string }) | null> => null;
export const hostLogoFile = async (_db: Conn, _host: string, _base?: Base): Promise<{ contentType: string; bytes: Uint8Array } | null> => null;

export async function orgIdsOfUser(db: Conn, userId: string): Promise<string[]> {
  const rows = await db.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, userId));
  return rows.map((r) => r.orgId);
}
