import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import {
  agentsHref,
  expiryLabel,
  madeLabel,
  parseProposalFilter,
  parseView,
  policyLine,
  previewRows,
  proposalError,
  proposalTitle,
  resourceAudience,
  type AgentsT,
} from "./agents";
import agents from "../messages/pages/agents";
import { makeTimeFormat } from "./time-format";

const t = createTranslator({ locale: "en", messages: { agents: agents.en }, namespace: "agents" }) as AgentsT;
const utcTf = makeTimeFormat({ zones: [], workspaceId: null });
const istTf = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });
const NOW = Date.parse("2026-10-18T09:45:00.000Z");

describe("views and hrefs", () => {
  it("defaults to connect and pending; unknown values fall back", () => {
    expect(parseView(undefined)).toBe("connect");
    expect(parseView("proposals")).toBe("proposals");
    expect(parseView("nope")).toBe("connect");
    expect(parseProposalFilter(undefined)).toBe("pending");
    expect(parseProposalFilter("all")).toBe("all");
    expect(parseProposalFilter("rejected")).toBe("pending");
  });

  it("omits defaults from the URL", () => {
    expect(agentsHref({})).toBe("/agents");
    expect(agentsHref({ view: "proposals" })).toBe("/agents?view=proposals");
    expect(agentsHref({ view: "proposals", status: "failed", proposal: "p1" })).toBe(
      "/agents?view=proposals&status=failed&proposal=p1",
    );
  });
});

describe("proposalTitle", () => {
  it("uses the action's own summary, first sentence only", () => {
    expect(
      proposalTitle("apiTokens.create", {
        summary: 'Would create a read-only API token named "x" (the secret is shown once, on apply). More.',
      }, t),
    ).toBe('Would create a read-only API token named "x" (the secret is shown once, on apply).');
  });

  it("canary: core's generic preview becomes 'Run <action>'", () => {
    expect(
      proposalTitle("placeActions.create", {
        summary:
          "Would run placeActions.create. This action has no detailed preview; the input below is exactly what will be applied.",
      }, t),
    ).toBe("Run placeActions.create");
    expect(proposalTitle("x.y", null, t)).toBe("Run x.y");
  });
});

describe("previewRows", () => {
  it("one row per input field of a generic preview, after the action", () => {
    const rows = previewRows("placeActions.create", {
      diff: {
        input: {
          locationId: "l1",
          placeActionType: "APPOINTMENT",
          uri: "https://clinic.example/book",
          isPreferred: true,
        },
      },
    }, t);
    expect(rows).toEqual([
      { field: "Action", value: "placeActions.create", mono: true },
      { field: "Location id", value: "l1", mono: false },
      { field: "Place action type", value: "APPOINTMENT", mono: false },
      { field: "Uri", value: "https://clinic.example/book", mono: true },
      { field: "Is preferred", value: "Yes", mono: false },
    ]);
  });

  it("any other diff shape is shown as one JSON row; no diff leaves only the action", () => {
    expect(previewRows("a.b", { diff: [1, 2] }, t)).toEqual([
      { field: "Action", value: "a.b", mono: true },
      { field: "Change", value: "[1,2]", mono: true },
    ]);
    expect(previewRows("a.b", { diff: null }, t)).toHaveLength(1);
  });
});

describe("policyLine", () => {
  it("passes with no blocking finding, names the rules when blocked", () => {
    expect(policyLine({ findings: { ok: true, violations: [] } }, t)).toEqual({
      ok: true,
      text: "Policy check passed. It runs again when you apply.",
    });
    const blocked = policyLine({
      findings: { ok: false, violations: [{ severity: "block", ruleId: "U7.url" }, { severity: "warn", ruleId: "X" }] },
    }, t);
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain("Contains a link");
    expect(blocked.text).not.toContain("U7.url");
    expect(blocked.text).not.toContain("X,");
  });
});

describe("times", () => {
  it("pending proposals count down in whole minutes; 5 or less is soon", () => {
    expect(expiryLabel("pending", "2026-10-18T09:56:00.000Z", NOW)).toEqual({ text: "in 11 min", soon: false });
    expect(expiryLabel("pending", "2026-10-18T09:49:00.000Z", NOW)).toEqual({ text: "in 4 min", soon: true });
    expect(expiryLabel("expired", "2026-10-18T09:12:00.000Z", NOW, utcTf)).toEqual({ text: "09:12", soon: false });
    expect(expiryLabel("expired", "2026-10-18T09:12:00.000Z", NOW, istTf)).toEqual({ text: "14:42", soon: false });
  });

  it("made today shows the time; another day shows the date too, in the page's zone", () => {
    expect(madeLabel("2026-10-18T09:41:00.000Z", NOW, utcTf)).toBe("09:41");
    expect(madeLabel("2026-10-17T23:59:00.000Z", NOW, utcTf)).toBe("2026-10-17 23:59");
    // 23:59 UTC on the 17th is already the 18th in Kolkata, so it counts as today there
    expect(madeLabel("2026-10-17T23:59:00.000Z", NOW, istTf)).toBe("05:29");
    expect(madeLabel("2026-10-17T10:00:00.000Z", NOW, istTf)).toBe("17/10/2026 15:30");
  });
});

describe("proposalError", () => {
  it("splits CODE: message and labels known failure codes", () => {
    expect(proposalError("NOT_FOUND: Group not found")).toEqual({ code: "NOT_FOUND", message: "Group not found" });
    expect(proposalError("google_writes_disabled: Google write x refused")).toEqual({
      code: "google_writes_disabled",
      message: "Google writes are turned off on this server.",
    });
  });

  it("rows written before CODE: message keep their text under a generic code", () => {
    expect(proposalError('Google write x refused: GOOGLE_BUSINESS_WRITES is not "live"')).toEqual({
      code: "failed",
      message: 'Google write x refused: GOOGLE_BUSINESS_WRITES is not "live"',
    });
    expect(proposalError(null)).toBeNull();
  });
});

describe("resourceAudience", () => {
  it("names the roles, in role order", () => {
    const all = ["owner", "admin", "manager", "client_approver", "client_viewer"];
    expect(resourceAudience(all, t)).toBe("Any role can read it");
    expect(resourceAudience(["admin", "owner"], t)).toBe("Owners and admins only");
    expect(resourceAudience(["owner", "admin", "manager", "client_approver"], t)).toBe(
      "Owners, admins, managers and client approvers only",
    );
    expect(resourceAudience(["owner"], t)).toBe("Owners only");
  });
});
