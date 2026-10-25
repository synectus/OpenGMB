import { eq } from "drizzle-orm";
import { z } from "zod";
import { orgBranding, organizations, type Db, type Tx } from "@opengmb/db";

export type Branding = {
  agencyName: string;
  /** https URL or null. */
  logoUrl: string | null;
  /** #rrggbb or null. */
  primaryColor: string | null;
  accentColor: string | null;
};

/** #rrggbb only (no shorthand, no alpha), normalised to lower case. */
export const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour")
  .transform((v) => v.toLowerCase());

/** An https URL without credentials. Checked through URL, not by string prefix. */
export const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && u.username === "" && u.password === "";
    } catch {
      return false;
    }
  }, "Logo URL must be an https URL");

/** Branding for an org; the agency name falls back to the organization name. */
export async function loadBranding(db: Db | Tx, orgId: string): Promise<Branding> {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  const [b] = await db.select().from(orgBranding).where(eq(orgBranding.orgId, orgId));
  return {
    agencyName: b?.agencyName?.trim() || org?.name || "OpenGMB",
    logoUrl: b?.logoUrl ?? null,
    primaryColor: b?.primaryColor ?? null,
    accentColor: b?.accentColor ?? null,
  };
}
