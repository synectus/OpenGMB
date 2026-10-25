// Pure logic for the Suspension tab. Client-safe: only types come from core.
import type { suspensionCasesList } from "@opengmb/core";
import { statusWords } from "./labels";
import type { TimeFormat } from "./time-format";

export type CaseData = Awaited<ReturnType<(typeof suspensionCasesList)["handler"]>>["cases"][number];
export type CaseStatus = CaseData["status"];


/** "Opened 2026-10-09 | appeal not submitted | evidence 5/10" (totals come from the case). */
export function caseMeta(c: CaseData, tf: TimeFormat): string {
  const day = (iso: string) => tf.date(iso, c.workspaceId);
  const parts = [
    `Opened ${day(c.openedAt)}`,
    c.appealSubmittedAt ? `appeal submitted ${day(c.appealSubmittedAt)}` : "appeal not submitted",
  ];
  if (c.outcomeAt) parts.push(`outcome ${day(c.outcomeAt)}`);
  parts.push(`evidence ${c.checklistDone}/${c.checklistTotal}`);
  return parts.join(" | ");
}

export const waitingLine = (c: CaseData, tf: TimeFormat) =>
  c.status === "appealed" && c.appealSubmittedAt
    ? `Appeal submitted ${tf.date(c.appealSubmittedAt, c.workspaceId)}. Waiting on Google.`
    : null;

export const statusWord = (s: CaseStatus) => statusWords(s);
export const CASE_TONE: Record<CaseStatus, "warn" | "info" | "good" | "neutral"> = {
  open: "warn",
  appealed: "info",
  reinstated: "good",
  closed_lost: "neutral",
};
export const isFinished = (s: CaseStatus) => s === "reinstated" || s === "closed_lost";

/** Mirrors SUSPENSION_TRANSITIONS in core: open -> appealed (once) -> an outcome; finished cases take notes only. */
export const caseButtons = (s: CaseStatus) => ({
  appeal: s === "open",
  outcome: s === "open" || s === "appealed",
  notes: isFinished(s),
  checklist: !isFinished(s),
});

export const doneLabels = (c: CaseData) => c.evidenceChecklist.filter((i) => i.done).map((i) => i.label);

export const reasonProblem = (reason: string) =>
  reason.trim() ? null : "INVALID_INPUT: Describe what happened before opening a case.";
