import { describe, expect, it } from "vitest";
import {
  BACKUP_CODES_FILE,
  INVITE_ROLES,
  backupCodesText,
  inviteAccessLine,
  inviteExpiry,
  invitePlace,
  secretGroups,
} from "./auth-pages";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("secretGroups", () => {
  // The smoke test reads the <code> text as the TOTP secret, so the groups must join back exactly.
  it("splits into groups of 4 that join back to the secret unchanged (canary for the e2e read)", () => {
    const s = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXPABCD";
    const g = secretGroups(s);
    expect(g.join("")).toBe(s);
    expect(g.slice(0, 2)).toEqual(["JBSW", "Y3DP"]);
    expect(g.every((x) => x.length <= 4 && !/\s/.test(x))).toBe(true);
  });

  it("keeps a short tail and returns [] for an empty secret", () => {
    expect(secretGroups("ABCDEF")).toEqual(["ABCD", "EF"]);
    expect(secretGroups("")).toEqual([]);
  });
});

describe("backupCodesText", () => {
  it("one code per line under a heading, ending in a newline", () => {
    const codes = ["aB3dE-f9GhJ", "Kx2pQ-7mNbV"];
    const t = backupCodesText(codes);
    expect(t.split("\n")).toEqual([
      "OpenGMB backup codes. Each code works once.",
      "",
      "aB3dE-f9GhJ",
      "Kx2pQ-7mNbV",
      "",
    ]);
    expect(BACKUP_CODES_FILE).toBe("opengmb-backup-codes.txt");
  });
});

describe("invitation copy", () => {
  const base = {
    email: "dana@example.test",
    inviterName: "Priya",
    orgName: "Synectus",
    expiresAt: "2026-10-25T23:59:59.000Z",
  };
  it("covers exactly the three invitable roles (DB check invitations_role_invitable)", () => {
    expect(Object.keys(INVITE_ROLES).sort()).toEqual(["client_approver", "client_viewer", "manager"]);
    expect(INVITE_ROLES.client_viewer).toEqual({
      name: "Client viewer",
      text: "You can view reviews and content for your business.",
      perks: ["See reviews and replies", "See posts and profile changes", "No changes to Google"],
    });
    expect(INVITE_ROLES.client_approver.text).toBe("You can approve content for your business.");
    expect(INVITE_ROLES.manager.text).toBe(
      "You can help manage Google Business Profiles across the whole organization.",
    );
  });

  it("a client invitation is for its workspace; a manager invitation is for the organization", () => {
    expect(invitePlace({ ...base, workspaceName: "Northside Chiro" })).toBe("Northside Chiro");
    expect(invitePlace({ ...base, workspaceName: null })).toBe("Synectus");
    expect(inviteAccessLine({ ...base, workspaceName: "Northside Chiro" })).toBe(
      "Accepting gives access only to Northside Chiro. Two-factor authentication is required.",
    );
    expect(inviteAccessLine({ ...base, workspaceName: null })).toBe(
      "Two-factor authentication is required.",
    );
  });

  it("states the expiry date in the given format", () => {
    expect(inviteExpiry({ ...base, workspaceName: null }, utc)).toBe("Invitation expires 2026-10-25.");
    expect(inviteExpiry({ ...base, workspaceName: null }, ist)).toBe("Invitation expires 26/10/2026.");
  });
});
