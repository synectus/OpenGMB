import { describe, expect, it } from "vitest";
import {
  LOW_BACKUP_CODES,
  backupCodesLine,
  isLowBackupCodes,
  lowCodesHeadline,
  newPasswordProblem,
  organizationLine,
  passwordChangeError,
  roleLabel,
  verifyLowCodesText,
} from "./account";

describe("backup code lines", () => {
  it("states left of total", () => {
    expect(backupCodesLine(8, 10)).toBe("Backup codes: 8 of 10 left");
  });

  it("is low at 3 or fewer (boundary)", () => {
    expect(LOW_BACKUP_CODES).toBe(3);
    expect(isLowBackupCodes(3)).toBe(true);
    expect(isLowBackupCodes(4)).toBe(false);
    expect(isLowBackupCodes(0)).toBe(true);
  });

  it("singular and plural", () => {
    expect(lowCodesHeadline(2)).toBe("2 backup codes left.");
    expect(lowCodesHeadline(1)).toBe("1 backup code left.");
    expect(verifyLowCodesText(2)).toBe("You have 2 backup codes left. Make new ones in your account.");
    expect(verifyLowCodesText(1)).toBe("You have 1 backup code left. Make new ones in your account.");
  });
});

describe("password change", () => {
  it("catches a mismatch before calling the server", () => {
    expect(newPasswordProblem("abcdefgh", "abcdefgx")).toBe("Passwords do not match");
    expect(newPasswordProblem("abcdefgh", "abcdefgh")).toBeNull();
  });

  it("puts a wrong current password on that field; anything else is shown as returned", () => {
    expect(passwordChangeError({ code: "INVALID_PASSWORD", message: "Invalid password" })).toEqual({
      field: "current",
      message: "Current password is incorrect",
    });
    expect(passwordChangeError({ code: "PASSWORD_TOO_SHORT", message: "Password too short" })).toEqual({
      field: "form",
      message: "Password too short",
    });
    expect(passwordChangeError({})).toEqual({
      field: "form",
      message: "Could not change your password, please try again",
    });
  });
});

describe("organization line", () => {
  it("staff see the organization and role; clients see their workspaces and role", () => {
    expect(roleLabel("owner")).toBe("Owner");
    expect(roleLabel("client_viewer")).toBe("Client viewer");
    expect(organizationLine({ role: "owner", orgName: "Synectus", workspaceNames: [] })).toBe(
      "Synectus · Owner",
    );
    expect(
      organizationLine({
        role: "client_viewer",
        orgName: "Synectus",
        workspaceNames: ["Northside Chiro"],
      }),
    ).toBe("Northside Chiro · Client viewer");
  });
});
