import { KNOWN_CLIENT_HOSTS, type ConnectableOrg } from "@opengmb/core";

export function redirectHostOf(uri: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

/** Hostname without port against the short known list (spec: a warning, not a gate). */
export function isKnownClientHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return (KNOWN_CLIENT_HOSTS as readonly string[]).includes(name);
}

export type ConsentChoice = { orgId: string; access: "read" | "write"; fullAutonomy: boolean };

export function parseConsentChoice(
  form: { orgId?: unknown; access?: unknown; fullAutonomy?: unknown },
  orgs: readonly ConnectableOrg[],
): ConsentChoice | { error: "account" } {
  const org = orgs.length === 1 ? orgs[0] : orgs.find((o) => o.orgId === form.orgId);
  if (!org) return { error: "account" };
  const access = form.access === "write" && !org.readOnly ? "write" : "read";
  return { orgId: org.orgId, access, fullAutonomy: access === "write" && (form.fullAutonomy === "on" || form.fullAutonomy === true) };
}
