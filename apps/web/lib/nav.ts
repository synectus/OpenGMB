// Client-safe: only a type comes from core (erased at build), so the sidebar can import isActive.
import type { Permission } from "@opengmb/core";
import { settingsNavFor } from "./settings-nav";

export type NavIconName =
  | "home"
  | "star"
  | "edit"
  | "pin"
  | "chart"
  | "grid"
  | "file"
  | "link"
  | "folder"
  | "reply"
  | "template"
  | "users"
  | "palette"
  | "key"
  | "shield"
  | "check"
  | "bot"
  | "gear"
  | "bell"
  | "activity";

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconName;
  /** A count shown on the link. Absent (not 0) when there is nothing to show. */
  badge?: number;
  /** Screen-reader words after the count: "7 waiting", "26 need a reply". */
  badgeLabel?: string;
  /** Filled primary badge (work that waits on this person); others are neutral. */
  urgent?: boolean;
  /** Other route prefixes on which this item is current (Settings: /workspaces, /audit). */
  also?: string[];
};
export type NavGroup = { label: string | null; items: NavItem[] };

type Def = NavItem & { permission?: Permission };

const SETTINGS_HREF = "/settings";

const NAV: { label: string | null; items: Def[] }[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Needs attention", icon: "home" },
      { href: "/approvals", label: "Approvals", icon: "check", permission: "review:approve", badgeLabel: "waiting", urgent: true },
      { href: "/reviews", label: "Reviews", icon: "star", badgeLabel: "need a reply" },
      { href: "/posts", label: "Posts", icon: "edit" },
      { href: "/locations", label: "Locations", icon: "pin", badgeLabel: "open alerts" },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/performance", label: "Performance", icon: "chart" },
      { href: "/geogrid", label: "Rank tracking", icon: "grid" },
      { href: "/reports", label: "Reports", icon: "file" },
    ],
  },
  {
    label: null,
    items: [{ href: "/agents", label: "AI agents", icon: "bot", permission: "api_token:manage_own" }],
  },
  {
    label: null,
    items: [{ href: SETTINGS_HREF, label: "Settings", icon: "gear", also: ["/workspaces", "/audit"] }],
  },
];

/**
 * The nav for one role. `can` is core's roleHasPermission bound to the caller's role (server side).
 * `badges` maps an href to a count; zero or missing means no badge.
 */
export function navFor(
  can: (p: Permission) => boolean,
  badges: Readonly<Record<string, number>> = {},
): NavGroup[] {
  return NAV.map((g) => ({
    label: g.label,
    items: g.items
      .filter((i) => !i.permission || can(i.permission))
      .map(({ href, label, icon, also, badgeLabel, urgent }): NavItem => {
        const item: NavItem = also ? { href, label, icon, also } : { href, label, icon };
        const badge = badges[href];
        if (!badge || badge <= 0) return item;
        return { ...item, badge, badgeLabel: badgeLabel ?? "waiting", ...(urgent ? { urgent } : {}) };
      }),
  })).filter((g) => g.items.length > 0);
}

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/** isActive for one sidebar item, counting its extra routes. */
export function isNavItemActive(pathname: string, item: Pick<NavItem, "href" | "also">): boolean {
  return [item.href, ...(item.also ?? [])].some((href) => isActive(pathname, href));
}

/**
 * The ⌘K groups: the sidebar without its Settings link (it only redirects), then every settings
 * page the role can open, so collapsing the sidebar group removes nothing from search.
 */
export function commandNavFor(can: (p: Permission) => boolean, sidebar: NavGroup[]): NavGroup[] {
  const pages = sidebar
    .map((g) => ({ ...g, items: g.items.filter((i) => i.href !== SETTINGS_HREF) }))
    .filter((g) => g.items.length > 0);
  const settings = settingsNavFor(can);
  return settings.length > 0 ? [...pages, { label: "Settings", items: settings }] : pages;
}
