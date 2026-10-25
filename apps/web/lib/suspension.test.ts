import { describe, expect, it } from "vitest";
import { makeTimeFormat } from "./time-format";
import { CASE_TONE, caseButtons, caseMeta, doneLabels, isFinished, reasonProblem, statusWord, waitingLine, type CaseData } from "./suspension";

const item = (key: string, done: boolean, note = "") => ({ key, label: `L ${key}`, done, note });
const kase = (over: Partial<CaseData> = {}): CaseData => ({
  id: "c",
  locationId: "l",
  locationName: "Rivermoor Del Mar",
  workspaceId: "w",
  openedAt: "2026-10-09T08:00:00.000Z",
  reason: "Suspended after an address change.",
  status: "open",
  appealSubmittedAt: null,
  outcomeAt: null,
  outcomeNotes: null,
  evidenceChecklist: [item("a", true), item("b", false)],
  checklistDone: 1,
  checklistTotal: 2,
  createdBy: "u",
  updatedAt: "2026-10-09T08:00:00.000Z",
  ...over,
});


const utc = makeTimeFormat({ zones: [{ id: "w", timeZone: "UTC", dateFormat: "YYYY-MM-DD" }], workspaceId: "w" });
const ist = makeTimeFormat({ zones: [{ id: "w", timeZone: "Asia/Kolkata", dateFormat: "DD/MM/YYYY" }], workspaceId: "w" });

describe("suspension case lines", () => {
  it("meta: opened, appeal, outcome only when there is one, evidence from the case's own totals", () => {
    expect(caseMeta(kase(), utc)).toBe("Opened 2026-10-09 | appeal not submitted | evidence 1/2");
    expect(caseMeta(kase(), ist)).toBe("Opened 09/10/2026 | appeal not submitted | evidence 1/2");
    expect(
      caseMeta(kase({ status: "reinstated", appealSubmittedAt: "2025-06-05T00:00:00Z", outcomeAt: "2025-06-20T00:00:00Z", checklistDone: 10, checklistTotal: 10 }), utc),
    ).toBe("Opened 2026-10-09 | appeal submitted 2025-06-05 | outcome 2025-06-20 | evidence 10/10");
  });
  it("waiting line only while appealed", () => {
    expect(waitingLine(kase({ status: "appealed", appealSubmittedAt: "2026-10-12T09:00:00Z" }), utc)).toBe(
      "Appeal submitted 2026-10-12. Waiting on Google.",
    );
    expect(waitingLine(kase(), utc)).toBeNull();
  });
  it("status words, tones, finished", () => {
    expect(statusWord("closed_lost")).toBe("closed lost");
    expect(CASE_TONE.appealed).toBe("info");
    expect(isFinished("reinstated")).toBe(true);
    expect(isFinished("appealed")).toBe(false);
  });
  it("buttons follow the transitions (one appeal, then an outcome)", () => {
    expect(caseButtons("open")).toEqual({ appeal: true, outcome: true, notes: false, checklist: true });
    expect(caseButtons("appealed")).toEqual({ appeal: false, outcome: true, notes: false, checklist: true });
    expect(caseButtons("closed_lost")).toEqual({ appeal: false, outcome: false, notes: true, checklist: false });
  });
  it("done labels for the read-only list", () => {
    expect(doneLabels(kase())).toEqual(["L a"]);
  });
  it("canary: an empty reason is refused before any request", () => {
    expect(reasonProblem("   ")).toBe("INVALID_INPUT: Describe what happened before opening a case.");
    expect(reasonProblem("Google suspended it.")).toBeNull();
  });
});
