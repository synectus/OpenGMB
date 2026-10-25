import { guardrailLabel } from "./labels";

/** Human labels for failure reason codes that jobs store; unknown codes are shown as they are. */
const FAILURE_LABELS: Record<string, string> = {
  google_writes_disabled: "Google writes are turned off on this server",
  location_inactive: "This location is inactive",
  location_not_linked_to_google: "This location is not linked to Google",
  connection_removed: "Reconnect Google in Settings",
  conflict: "Changed on Google since the preview; nothing was written",
  warnings_require_acknowledgement: "The warnings were not acknowledged before sending",
  unexpected_error: "Something went wrong while sending",
  google_rate_limited: "Google is limiting requests; the send gave up",
  google_http_403: "Google refused: check the connection's permissions",
  google_http_404: "Google could not find this location or post",
};

export function failureLabel(code: string): string {
  const exact = FAILURE_LABELS[code];
  if (exact) return exact;
  if (code.startsWith("guardrail_blocked:")) {
    return `Blocked by guardrails at send: ${code.slice("guardrail_blocked:".length).split(",").map((id) => guardrailLabel(id)).join("; ")}`;
  }
  if (code.startsWith("delete_failed:")) {
    return `Delete failed: ${failureLabel(code.slice("delete_failed:".length))}`;
  }
  return code;
}
