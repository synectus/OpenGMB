import { describe, expect, it } from "vitest";
import { commandNavFor, isActive, isNavItemActive, navFor } from "./nav";

const hrefs = (groups: ReturnType<typeof navFor>) => groups.flatMap((g) => g.items.map((i) => i.href));

describe("navFor", () => {
  it("shows every item to a role with every permission (denominator 10)", () => {
    expect(hrefs(navFor(() => true))).toEqual([
      "/",
      "/approvals",
      "/reviews",
      "/posts",
      "/locations",
      "/performance",
      "/geogrid",
      "/reports",
      "/agents",
      "/settings",
    ]);
  });

  it("shows Settings to every role, even one with a single permission", () => {
    expect(hrefs(navFor((p) => p === "notification:own"))).toContain("/settings");
  });

  it("puts Approvals right after Needs attention", () => {
    expect(hrefs(navFor(() => true)).slice(0, 3)).toEqual(["/", "/approvals", "/reviews"]);
  });

  it("puts AI agents right after Reports, before any settings item", () => {
    const h = hrefs(navFor(() => true));
    expect(h[h.indexOf("/reports") + 1]).toBe("/agents");
  });

  it("hides AI agents from a role without api_token:manage_own", () => {
    expect(hrefs(navFor((p) => p !== "api_token:manage_own"))).not.toContain("/agents");
  });

  it("hides Approvals from a role that cannot approve", () => {
    expect(hrefs(navFor((p) => p !== "review:approve"))).not.toContain("/approvals");
  });

  it("no longer lists settings pages in the sidebar", () => {
    const h = hrefs(navFor(() => true));
    for (const gone of ["/audit", "/settings/team", "/workspaces", "/settings/google"]) {
      expect(h).not.toContain(gone);
    }
  });

  it("drops a group that ends up empty", () => {
    expect(navFor(() => true).every((g) => g.items.length > 0)).toBe(true);
  });

  it("passes a count through as a badge, by href", () => {
    const items = navFor(() => true, { "/approvals": 5 }).flatMap((g) => g.items);
    expect(items.find((i) => i.href === "/approvals")?.badge).toBe(5);
    expect(items.filter((i) => i.badge !== undefined).map((i) => i.href)).toEqual(["/approvals"]);
  });

  it("canary: a zero or missing count leaves no badge key at all", () => {
    const zero = navFor(() => true, { "/approvals": 0 }).flatMap((g) => g.items);
    expect(zero.every((i) => !("badge" in i))).toBe(true);
    const none = navFor(() => true).flatMap((g) => g.items);
    expect(none.every((i) => !("badge" in i))).toBe(true);
    // a count for a page the role cannot see is ignored
    const hidden = navFor((p) => p !== "review:approve", { "/approvals": 3 }).flatMap((g) => g.items);
    expect(hidden.some((i) => "badge" in i)).toBe(false);
  });
});

describe("isActive", () => {
  it("no nav item is current on /account (it lives in the account menu)", () => {
    const all = navFor(() => true).flatMap((g) => g.items.map((i) => i.href));
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((h) => isActive("/account", h))).toEqual([]);
  });

  it("matches the home route exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/reviews", "/")).toBe(false);
  });

  it("matches nested routes but not prefixes of other words", () => {
    expect(isActive("/locations/abc/profile", "/locations")).toBe(true);
    expect(isActive("/locationsx", "/locations")).toBe(false);
    expect(isActive("/reviews/", "/reviews")).toBe(true);
  });
});

describe("isNavItemActive", () => {
  const settings = navFor(() => true)
    .flatMap((g) => g.items)
    .find((i) => i.href === "/settings")!;

  it("marks Settings current on every settings route, old routes included", () => {
    for (const path of ["/settings", "/settings/google", "/settings/team", "/workspaces", "/audit", "/audit/"]) {
      expect(isNavItemActive(path, settings)).toBe(true);
    }
  });

  it("canary: does not match other words that share a prefix", () => {
    for (const path of ["/settingsx", "/workspacesx", "/audits", "/reviews"]) {
      expect(isNavItemActive(path, settings)).toBe(false);
    }
  });

  it("falls back to isActive for items without extra routes", () => {
    const reviews = navFor(() => true)
      .flatMap((g) => g.items)
      .find((i) => i.href === "/reviews")!;
    expect(isNavItemActive("/reviews", reviews)).toBe(true);
    expect(isNavItemActive("/workspaces", reviews)).toBe(false);
  });
});

describe("commandNavFor", () => {
  it("lists the sidebar pages without the Settings link, then every settings page the role can open", () => {
    const can = () => true;
    const groups = commandNavFor(can, navFor(can));
    const flat = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(flat).not.toContain("/settings");
    expect(flat).toContain("/reviews");
    expect(groups.at(-1)?.label).toBe("Settings");
    expect(groups.at(-1)?.items).toHaveLength(13);
  });

  it("respects the role: no Audit log for a manager-like role", () => {
    const can = (p: string) => p !== "audit:read";
    const flat = commandNavFor(can, navFor(can)).flatMap((g) => g.items.map((i) => i.href));
    expect(flat).not.toContain("/audit");
    expect(flat).toContain("/settings/team");
  });

  it("names Home 'Needs attention'", () => {
    expect(navFor(() => true)[0]!.items[0]).toMatchObject({ href: "/", label: "Needs attention" });
  });

  it("carries the badge words and the urgent flag for Approvals, Reviews and Locations", () => {
    const items = navFor(() => true, { "/approvals": 7, "/reviews": 26, "/locations": 4 }).flatMap((g) => g.items);
    const pick = (href: string) => {
      const i = items.find((x) => x.href === href)!;
      return [i.badge, i.badgeLabel, i.urgent ?? false];
    };
    expect(pick("/approvals")).toEqual([7, "waiting", true]);
    expect(pick("/reviews")).toEqual([26, "need a reply", false]);
    expect(pick("/locations")).toEqual([4, "open alerts", false]);
  });
});
