// Client-safe: only types come from core, so the sidebar and the command palette can import it.
import type { Permission } from "@opengmb/core";
import { liveStatus } from "./live-status";
import type { NavItem } from "./nav";
import { PRIVATE_SETTINGS } from "./nav-private";

export type SettingsDef = NavItem & { permission: Permission; platformAdmin?: true; hostedOnly?: true };

/**
 * The Settings sub-nav, in canvas order. Workspaces and Audit log keep their old routes; only this
 * list groups them under Settings. Plan 5F adds
 * System status (last), each in the same commit as its route, so no entry ever links to a 404.
 * Each permission is the one the page's main read action needs.
 */
const SHARED_SETTINGS: SettingsDef[] = [
  { href: "/settings/google", label: "Google connection", icon: "link", permission: "google:read" },
  { href: "/workspaces", label: "Clients", icon: "folder", permission: "workspace:read" },
  { href: "/settings/workspace", label: "Reply settings", icon: "reply", permission: "review:read" },
  { href: "/settings/templates", label: "Reply templates", icon: "template", permission: "review:read" },
  { href: "/settings/branding", label: "Branding", icon: "palette", permission: "workspace:read" },
  { href: "/settings/tokens", label: "API tokens", icon: "key", permission: "api_token:manage_own" },
  { href: "/settings/notifications", label: "Notifications", icon: "bell", permission: "notification:own" },
  { href: "/account", label: "Your account", icon: "shield", permission: "notification:own" },
  { href: "/settings/privacy", label: "Privacy and data", icon: "shield", permission: "workspace:manage" },
  { href: "/audit", label: "Audit log", icon: "shield", permission: "audit:read" },
  { href: "/settings/health", label: "System health", icon: "activity", permission: "member:invite", platformAdmin: true },
  { href: "/settings/status", label: "System status", icon: "activity", permission: "location:read" },
];

/** Where each private entry goes: after the entry with the href named in its `after`. Entries are placed in list order. */
function withPrivate(shared: SettingsDef[]): SettingsDef[] {
  const out = [...shared];
  for (const { after, ...entry } of PRIVATE_SETTINGS) out.splice(out.findIndex((s) => s.href === after) + 1, 0, entry);
  return out;
}

const SETTINGS = withPrivate(SHARED_SETTINGS);

/** The settings pages one role may open. `can` is core's roleHasPermission bound to the role. */
export function settingsNavFor(can: (p: Permission) => boolean, platformAdmin = false, billingHosted = false): NavItem[] {
  return SETTINGS.filter((s) => can(s.permission) && (!s.platformAdmin || platformAdmin) && (!s.hostedOnly || billingHosted)).map(({ href, label, icon }) => ({
    href,
    label,
    icon,
  }));
}

/** Where `/settings` sends a role: its first settings page, or home when it has none. */
export function settingsHome(can: (p: Permission) => boolean): string {
  return settingsNavFor(can)[0]?.href ?? "/";
}

/** True only when this server publishes to Google: the same rule as the "What is live" pill. */
export function googleWritesLive(env: Record<string, string | undefined>): boolean {
  return liveStatus(env, false).rows.some((r) => r.key === "writes" && r.state === "live");
}
