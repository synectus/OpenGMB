import { describe, expect, it } from "vitest";
import { applyProfileDefaults } from "@opengmb/core";
import {
  chooseAuto,
  formFromSettings,
  genericOnlyAfterSave,
  parseStaffNames,
  previewChipText,
  profileSwitchNotice,
  PROFILES,
  requiredPack,
  settingsUpdate,
  staffNamesError,
  type SettingsValues,
} from "./reply-settings";

const base: SettingsValues = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  profile: "healthcare",
  packs: ["hipaa"],
  skipPositiveReviews: true,
  genericTemplatesOnly: true,
  staffNames: ["Dr. Ramos"],
  autoApproveMinStars: null,
  autoPublish: false,
  h2Severity: "block",
  draftOnArrival: false,
  autoApproveEnabledBy: null,
  autoApproveEnabledAt: null,
  autoApproveLocked: false,
};

describe("profile rules mirror core's applyProfileDefaults", () => {
  it("canary: required pack and generic-only for all 3 profiles", () => {
    expect(PROFILES.map((p) => p.value)).toEqual(["general", "healthcare", "legal"]);
    for (const { value } of PROFILES) {
      const core = applyProfileDefaults(value);
      expect(requiredPack(value)).toBe(core.packs[0] ?? null);
      expect(genericOnlyAfterSave(base, { ...formFromSettings(base), profile: value })).toBe(
        value === base.profile ? base.genericTemplatesOnly : core.genericTemplatesOnly,
      );
    }
  });
});

describe("settingsUpdate", () => {
  it("sends only the workspace id when nothing changed", () => {
    expect(settingsUpdate(base, formFromSettings(base))).toEqual({ workspaceId: base.workspaceId });
  });

  it("sends each changed field and nothing else", () => {
    const form = { ...formFromSettings(base), skip: false, staffText: "Dr. Ramos\n  Nurse Lee  \n\n", h2: "warn" as const };
    expect(settingsUpdate(base, form)).toEqual({
      workspaceId: base.workspaceId,
      skipPositiveReviews: false,
      staffNames: ["Dr. Ramos", "Nurse Lee"],
      h2Severity: "warn",
    });
  });

  it("sends draftOnArrival only when it changed", () => {
    expect(settingsUpdate(base, { ...formFromSettings(base), draftOnArrival: true })).toEqual({
      workspaceId: base.workspaceId,
      draftOnArrival: true,
    });
  });

  it("sends a profile switch alone so core can apply that profile's defaults", () => {
    expect(settingsUpdate(base, { ...formFromSettings(base), profile: "legal" })).toEqual({
      workspaceId: base.workspaceId,
      profile: "legal",
    });
  });

  it("does not treat a reordered pack list as a change", () => {
    const s = { ...base, packs: ["hipaa", "legal_ethics"] as SettingsValues["packs"] };
    expect(settingsUpdate(s, { ...formFromSettings(s), packs: ["legal_ethics", "hipaa"] })).toEqual({
      workspaceId: base.workspaceId,
    });
  });

  it("maps the auto-approve choice to 4, 5 or null", () => {
    expect(settingsUpdate(base, chooseAuto(formFromSettings(base), "5"))).toEqual({
      workspaceId: base.workspaceId,
      autoApproveMinStars: 5,
    });
    const on = { ...base, autoApproveMinStars: 4 as const, autoPublish: true };
    expect(settingsUpdate(on, chooseAuto(formFromSettings(on), "off"))).toEqual({
      workspaceId: base.workspaceId,
      autoApproveMinStars: null,
      autoPublish: false,
    });
  });
});

describe("chooseAuto", () => {
  it("turns auto-publish off with auto-approve, and leaves it alone otherwise", () => {
    const on = formFromSettings({ ...base, autoApproveMinStars: 5, autoPublish: true });
    expect(chooseAuto(on, "off").autoPublish).toBe(false);
    expect(chooseAuto(on, "4").autoPublish).toBe(true);
  });
});

describe("staff names", () => {
  it("parses one trimmed name per line, skipping blank lines", () => {
    expect(parseStaffNames(" A b \n\n C d\n")).toEqual(["A b", "C d"]);
  });

  it("uses the canvas error for more than 200 lines, and checks each name's length", () => {
    expect(staffNamesError(Array.from({ length: 200 }, (_, i) => `Name ${i}`))).toBeNull();
    expect(staffNamesError(Array.from({ length: 201 }, (_, i) => `Name ${i}`))).toBe(
      "INVALID_INPUT: Staff names: at most 200 lines.",
    );
    expect(staffNamesError(["X"])).toBe("INVALID_INPUT: Staff names: each name needs 2 to 80 characters.");
    expect(staffNamesError(["x".repeat(81)])).toBe(
      "INVALID_INPUT: Staff names: each name needs 2 to 80 characters.",
    );
  });
});

describe("profileSwitchNotice", () => {
  it("names the new profile only when it changed", () => {
    expect(profileSwitchNotice(base, formFromSettings(base))).toBeNull();
    expect(profileSwitchNotice(base, { ...formFromSettings(base), profile: "legal" })).toBe(
      "Saving applies the Legal defaults to the packs and the 4-5 star rule. Review them before you save.",
    );
  });
});

describe("previewChipText", () => {
  it("counts this form's unsaved choice with the other workspaces' saved rules", () => {
    expect(previewChipText([], "off")).toBeNull();
    expect(previewChipText([], "5")).toBe("Auto-approve 5★ is on in 1 client");
    expect(previewChipText([5, null], "5")).toBe("Auto-approve 5★ is on in 2 clients");
    expect(previewChipText([4], "off")).toBe("Auto-approve 4★ and up is on in 1 client");
    expect(previewChipText([4], "5")).toBe("Auto-approve 4★ or 5★ is on in 2 clients");
  });
});
