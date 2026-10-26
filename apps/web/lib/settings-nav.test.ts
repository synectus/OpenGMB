import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, roleHasPermission, type Role } from "@opengmb/core";
import { liveStatus } from "./live-status";
import { googleWritesLive, settingsHome, settingsNavFor } from "./settings-nav";

const hrefsFor = (role: Role) => settingsNavFor((p) => roleHasPermission(role, p)).map((i) => i.href);

describe("settingsNavFor", () => {
  it("lists every settings page, in canvas order, for a role with every permission (denominator 13)", () => {
    expect(settingsNavFor(() => true).map((i) => i.label)).toEqual([
      "Google connection",
      "Clients",
      "Reply settings",
      "Reply templates",
      "Team",
      "Branding",
      "API tokens",
      "Webhooks",
      "Notifications",
      "Your account",
      "Privacy and data",
      "Audit log",
      "System status",
    ]);
  });

  it("shows Organizations (after Team) only to a platform admin", () => {
    const can = () => true;
    expect(settingsNavFor(can).map((i) => i.href)).not.toContain("/settings/organizations");
    const labels = settingsNavFor(can, true).map((i) => i.label);
    expect(labels).toHaveLength(17);
    expect(labels).toContain("Admin panel");
    expect(settingsNavFor(can).map((i) => i.href)).not.toContain("/admin");
    expect(labels).toContain("System health");
    expect(labels).toContain("Integrations");
    expect(labels.indexOf("Organizations")).toBe(labels.indexOf("Team") + 1);
    expect(settingsNavFor(() => false, true)).toEqual([]);
  });

  it("keeps the old routes for Clients and Audit log", () => {
    const hrefs = settingsNavFor(() => true).map((i) => i.href);
    expect(hrefs).toContain("/workspaces");
    expect(hrefs).toContain("/audit");
    expect(hrefs).toContain("/account"); // name, password and two-factor live here
  });

  it("filters by each role's permissions (5 roles)", () => {
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(5);
    const all = settingsNavFor(() => true).map((i) => i.href);
    expect(hrefsFor("owner")).toEqual(all);
    expect(hrefsFor("admin")).toEqual(all);
    expect(hrefsFor("manager")).toEqual(all.filter((h) => h !== "/audit" && h !== "/settings/privacy" && h !== "/settings/webhooks"));
    const client = [
      "/workspaces",
      "/settings/workspace",
      "/settings/templates",
      "/settings/branding",
      "/settings/tokens",
      "/settings/notifications",
      "/account",
      "/settings/status",
    ];
    expect(hrefsFor("client_approver")).toEqual(client);
    expect(hrefsFor("client_viewer")).toEqual(client);
  });

  it("shows Webhooks to owners and admins only", () => {
    expect(hrefsFor("owner")).toContain("/settings/webhooks");
    expect(hrefsFor("admin")).toContain("/settings/webhooks");
    for (const r of ["manager", "client_approver", "client_viewer"] as const) {
      expect(hrefsFor(r)).not.toContain("/settings/webhooks");
    }
  });

  it("canary: a role with no permissions sees nothing", () => {
    expect(settingsNavFor(() => false)).toEqual([]);
  });
});

describe("Billing entry", () => {
  const billing = (role: Role, hosted: boolean) =>
    settingsNavFor((p) => roleHasPermission(role, p), false, hosted).map((i) => i.href).includes("/settings/billing");
  it("shows to owner and admin on a hosted server only, never to other roles", () => {
    expect(billing("owner", true)).toBe(true);
    expect(billing("admin", true)).toBe(true);
    for (const r of ["manager", "client_approver", "client_viewer"] as Role[]) expect(billing(r, true), r).toBe(false);
    expect(billing("owner", false)).toBe(false);
  });
});

describe("settingsHome", () => {
  it("lands on the first page the role can open", () => {
    expect(settingsHome((p) => roleHasPermission("owner", p))).toBe("/settings/google");
    expect(settingsHome((p) => roleHasPermission("client_viewer", p))).toBe("/workspaces");
    expect(settingsHome(() => false)).toBe("/");
  });
});

describe("googleWritesLive", () => {
  it("agrees with the live-status writes row for every mode and writes value", () => {
    const cases = [
      {},
      { GOOGLE_BUSINESS_API_MODE: "mock" },
      { GOOGLE_BUSINESS_API_MODE: "live" },
      { GOOGLE_BUSINESS_API_MODE: "live", GOOGLE_BUSINESS_WRITES: "off" },
      { GOOGLE_BUSINESS_API_MODE: "live", GOOGLE_BUSINESS_WRITES: "live" },
      { GOOGLE_BUSINESS_API_MODE: "live", GOOGLE_BUSINESS_WRITES: "yes" },
    ];
    for (const env of cases) {
      const row = liveStatus(env, false).rows.find((r) => r.key === "writes");
      expect(row).toBeDefined();
      expect(googleWritesLive(env)).toBe(row!.state === "live");
    }
  });

  it("canary: writes are live only with mode live and writes live", () => {
    expect(googleWritesLive({ GOOGLE_BUSINESS_API_MODE: "live", GOOGLE_BUSINESS_WRITES: "live" })).toBe(true);
    expect(googleWritesLive({})).toBe(false);
  });
});
