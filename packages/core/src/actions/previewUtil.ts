import type { GuardrailResult } from "../guardrails/types";
import type { ActionPreview } from "../registry";

/** Preview of an action whose dry run is an existing guardrail check action. */
export function guardrailPreview(
  what: string,
  result: GuardrailResult,
  diff: unknown,
): ActionPreview {
  const blocks = result.violations.filter((v) => v.severity === "block").length;
  const warns = result.violations.length - blocks;
  return {
    summary: `${what}: ${
      result.ok ? "no blocking guardrail findings" : `blocked by ${blocks} guardrail finding(s)`
    }${warns > 0 ? `, ${warns} warning(s)` : ""}. Nothing was written.`,
    diff,
    findings: result,
  };
}
