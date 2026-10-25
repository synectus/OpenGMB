import "server-only";
import { headers } from "next/headers";
import { hostBranding, isGoogleConfigured, type Branding } from "@opengmb/core";
import type { Db } from "@opengmb/db";
import { getDb } from "./auth";
import { isMainHost, requestHost } from "./request-host";
import { brandCss, type ShellBrand } from "./theme/brand";

export type HostBrand = { branding: Branding; brand: ShellBrand; css: string | null };

/**
 * Brand block for an agency's own address. Unlike shellBrand (which stays "SynGMB" until a logo or
 * colour is set), the agency's name always shows here: the address itself says whose it is.
 */
export function hostShellBrand(b: Branding): ShellBrand {
  const name = b.agencyName.trim() || "OpenGMB";
  return { name, subline: "Powered by OpenGMB", mark: name.charAt(0).toUpperCase() || "O", logoUrl: b.logoUrl };
}

/** Brand for a request host, or null on the main host and unknown hosts. */
export async function hostBrandOf(db: Db, host: string | null): Promise<HostBrand | null> {
  if (!host || isMainHost(host)) return null;
  const branding = await hostBranding(db, host);
  return branding ? { branding, brand: hostShellBrand(branding), css: brandCss(branding) } : null;
}

/** Brand for the current request's host (server components). */
export async function currentHostBrand(): Promise<HostBrand | null> {
  return hostBrandOf(getDb(), requestHost(await headers()));
}

/** "Sign in with Google" only on the main host: the OAuth redirect address is registered for it alone (D3). */
export function googleEnabledFor(host: string | null): boolean {
  return isMainHost(host) && isGoogleConfigured();
}

export async function currentIsMainHost(): Promise<boolean> {
  return isMainHost(requestHost(await headers()));
}

export async function currentGoogleEnabled(): Promise<boolean> {
  return googleEnabledFor(requestHost(await headers()));
}
