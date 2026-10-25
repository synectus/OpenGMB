import { describe, expect, it } from "vitest";
import {
  activeCount,
  commentCount,
  definitionInput,
  emailText,
  emailedText,
  expiryOptions,
  kindText,
  languageText,
  linkCell,
  periodText,
  runErrorHint,
  runErrorText,
  scheduleText,
  scopeText,
  statusWait,
  triggerText,
  type EditorState,
} from "./reports";
import { makeTimeFormat } from "./time-format";

const utc = makeTimeFormat({ zones: [], workspaceId: null });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

const MB5 = 5 * 1024 * 1024;

describe("row texts", () => {
  it("scope, period, language, email", () => {
    expect(scopeText({ scope: "workspace", locationIds: [], groupId: null }, new Map())).toBe("Whole client");
    expect(scopeText({ scope: "locations", locationIds: ["a", "b"], groupId: null }, new Map())).toBe("2 chosen locations");
    expect(scopeText({ scope: "locations", locationIds: ["a"], groupId: null }, new Map())).toBe("1 chosen location");
    expect(scopeText({ scope: "group", locationIds: [], groupId: "g" }, new Map([["g", "Downtown"]]))).toBe("Group Downtown");
    expect(scopeText({ scope: "group", locationIds: [], groupId: null }, new Map())).toBe("Group deleted");
    expect(periodText({ period: "last_month", customFrom: null, customTo: null }, utc)).toBe("Last month");
    expect(periodText({ period: "last_30_days", customFrom: null, customTo: null }, utc)).toBe("Last 30 days");
    expect(periodText({ period: "custom", customFrom: "2026-09-01", customTo: "2026-09-15" }, utc)).toBe("2026-09-01 to 2026-09-15");
    expect(periodText({ period: "custom", customFrom: "2026-09-01", customTo: "2026-09-15" }, ist)).toBe("01/09/2026 to 15/09/2026");
    expect(languageText("es")).toBe("Spanish");
    expect(emailText({ schedule: "monthly", recipients: ["a", "b"] })).toBe("to 2 recipients");
    expect(emailText({ schedule: "monthly", recipients: ["a"] })).toBe("to 1 recipient");
    expect(emailText({ schedule: "none", recipients: ["a"] })).toBe("off");
    expect(activeCount([{ id: "1" }, { id: "2" }])).toBe("Active: 2");
  });
  it("runs: trigger, wait text, errors, emailed, time", () => {
    expect(triggerText({ trigger: "schedule", requestedByName: null })).toBe("schedule");
    expect(triggerText({ trigger: "manual", requestedByName: "Priya" })).toBe("manual · Priya");
    expect(triggerText({ trigger: "manual", requestedByName: null })).toBe("manual");
    expect(statusWait("queued")).toBe("Waiting for the worker");
    expect(statusWait("running")).toBe("Building the PDF");
    expect(statusWait("done")).toBeNull();
    expect(runErrorText("pdf_too_large", MB5)).toBe("pdf_too_large: PDF over the 5 MB size cap");
    expect(runErrorText("group_missing", MB5)).toBe("group_missing: The group of this report was deleted. Pick another scope.");
    expect(runErrorText("something_new", MB5)).toBe("something_new");
    expect(runErrorHint("pdf_too_large")).toBe("Pick fewer locations or a shorter period.");
    expect(runErrorHint("render_failed")).toBeNull();
    expect(emailedText({ trigger: "schedule", emailedAt: "2026-10-01T14:03:00.000Z" }, true, utc)).toBe("2026-10-01 14:03");
    expect(emailedText({ trigger: "schedule", emailedAt: "2026-10-01T14:03:00.000Z" }, true, ist)).toBe("01/10/2026 19:33");
    expect(emailedText({ trigger: "schedule", emailedAt: null }, false, utc)).toBe("Not sent: email is not set up");
    expect(emailedText({ trigger: "schedule", emailedAt: null }, true, utc)).toBe("Not sent yet");
    expect(emailedText({ trigger: "manual", emailedAt: null }, true, utc)).toBe("·");
  });
  it("link cell: newest active link with Revoke, else inactive with the revoke date, else a dot", () => {
    const active = { id: "a", expiresAt: "2026-10-31T09:00:00.000Z", revokedAt: null, createdAt: "2026-10-02T00:00:00.000Z", active: true };
    const revoked = { id: "r", expiresAt: "2026-10-20T00:00:00.000Z", revokedAt: "2026-10-16T08:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", active: false };
    expect(linkCell([revoked, active], utc)).toEqual({ text: "until 2026-10-31", revokeId: "a", note: null });
    expect(linkCell([revoked], utc)).toEqual({ text: "inactive", revokeId: null, note: "Revoked on 2026-10-16. The link no longer opens." });
    expect(linkCell([{ ...revoked, revokedAt: null }], utc)).toEqual({ text: "inactive", revokeId: null, note: null });
    expect(linkCell([], utc)).toEqual({ text: "·", revokeId: null, note: null });
  });
  it("expiry options, schedule text, comment count", () => {
    expect(expiryOptions(30)).toEqual([1, 7, 14, 30]);
    expect(expiryOptions(10)).toEqual([1, 7]);
    expect(scheduleText("0 14 1 * *", 30, utc)).toBe("Each recipient gets a 30-day link, never an attachment. Sent on the 1st at 14:00 UTC.");
    expect(scheduleText("0 14 1 * *", 30, ist)).toBe("Each recipient gets a 30-day link, never an attachment. Sent on the 1st at 14:00 IST.");
    expect(scheduleText("5 9 2 * *", 7, utc)).toBe("Each recipient gets a 7-day link, never an attachment. Sent on the 2nd at 09:05 UTC.");
    expect(commentCount("  abc  ")).toBe("3 of 500 characters");
  });
});

describe("definitionInput", () => {
  const base: EditorState = {
    kind: "performance",
    workspaceId: "w",
    name: " Monthly performance ",
    scope: "workspace",
    groupId: "",
    locationIds: [],
    period: "last_month",
    customFrom: "",
    customTo: "",
    language: "en",
    comment: "",
    aiSummary: false,
    agencyName: "Synectus",
    colour: "#c2410c",
    schedule: "none",
    recipients: "",
  };
  it("maps the form to the action input", () => {
    expect(definitionInput(base)).toEqual({
      ok: true,
      input: {
        workspaceId: "w",
        kind: "performance",
        name: "Monthly performance",
        scope: "workspace",
        locationIds: [],
        groupId: null,
        period: "last_month",
        customFrom: null,
        customTo: null,
        language: "en",
        comment: null,
        aiSummary: false,
        schedule: "none",
        recipients: [],
        branding: { agencyName: "Synectus", colour: "#c2410c" },
      },
    });
  });
  it("sends the AI summary choice as chosen (off unless ticked)", () => {
    const on = definitionInput({ ...base, aiSummary: true });
    expect(on.ok && on.input.aiSummary).toBe(true);
  });
  it("group, chosen locations, custom period, recipients", () => {
    const g = definitionInput({ ...base, scope: "group", groupId: "g1", locationIds: ["x"] });
    expect(g.ok && g.input).toMatchObject({ scope: "group", groupId: "g1", locationIds: [] });
    const l = definitionInput({ ...base, scope: "locations", locationIds: ["a", "b"], groupId: "g1" });
    expect(l.ok && l.input).toMatchObject({ scope: "locations", locationIds: ["a", "b"], groupId: null });
    const c = definitionInput({ ...base, period: "custom", customFrom: "2026-09-01", customTo: "2026-09-30" });
    expect(c.ok && c.input).toMatchObject({ customFrom: "2026-09-01", customTo: "2026-09-30" });
    const m = definitionInput({ ...base, schedule: "monthly", recipients: " a@x.test, ,b@x.test " });
    expect(m.ok && m.input.recipients).toEqual(["a@x.test", "b@x.test"]);
    const b = definitionInput({ ...base, agencyName: " ", colour: "" });
    expect(b.ok && b.input.branding).toEqual({});
  });
  it("says what is missing before calling the server", () => {
    const bad = (over: Partial<EditorState>) => {
      const r = definitionInput({ ...base, ...over });
      return r.ok ? null : r.error;
    };
    expect(bad({ name: "  " })).toBe("INVALID_INPUT: Give the report a name");
    expect(bad({ scope: "group", groupId: "" })).toBe("INVALID_INPUT: Pick a group");
    expect(bad({ scope: "locations", locationIds: [] })).toBe("INVALID_INPUT: Pick at least one location");
    expect(bad({ period: "custom", customFrom: "2026-09-01" })).toBe("INVALID_INPUT: A custom period needs both dates");
    expect(bad({ schedule: "monthly" })).toBe("INVALID_INPUT: A monthly email needs at least one recipient");
    expect(bad({ comment: "x".repeat(501) })).toBe("INVALID_INPUT: The comment is 501 characters; the limit is 500");
    expect(bad({ colour: "red" })).toBe("INVALID_INPUT: Use a colour like #1F4E79");
  });
});

describe("report kind", () => {
  const base: EditorState = {
    kind: "performance", workspaceId: "w", name: "R", scope: "workspace", groupId: "", locationIds: [],
    period: "last_month", customFrom: "", customTo: "", language: "en", comment: "", aiSummary: false, agencyName: "", colour: "",
    schedule: "none", recipients: "",
  };
  it("kindText", () => {
    expect(kindText("performance")).toBe("Performance");
    expect(kindText("reviews")).toBe("Review");
  });
  it("definitionInput carries the kind", () => {
    const r = definitionInput({ ...base, kind: "reviews" });
    expect(r.ok && r.input.kind).toBe("reviews");
  });
});
