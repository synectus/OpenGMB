import { describe, expect, it } from "vitest";
import { failureLabel } from "./failure-labels";

describe("failureLabel", () => {
  it("canary: every code the change set and photo pages show has the board's words", () => {
    expect(failureLabel("google_writes_disabled")).toBe("Google writes are turned off on this server");
    expect(failureLabel("location_inactive")).toBe("This location is inactive");
    expect(failureLabel("location_not_linked_to_google")).toBe("This location is not linked to Google");
    expect(failureLabel("connection_removed")).toBe("Reconnect Google in Settings");
    expect(failureLabel("conflict")).toBe("Changed on Google since the preview; nothing was written");
  });
  it("unknown codes are shown as they are", () => {
    expect(failureLabel("google_http_400")).toBe("google_http_400");
  });
});

describe("failureLabel for post sends", () => {
  it("canary: the codes posts/jobs.ts and googleFailure store have words", () => {
    expect(failureLabel("warnings_require_acknowledgement")).toBe(
      "The warnings were not acknowledged before sending",
    );
    expect(failureLabel("unexpected_error")).toBe("Something went wrong while sending");
    expect(failureLabel("google_rate_limited")).toBe("Google is limiting requests; the send gave up");
    expect(failureLabel("google_http_403")).toBe("Google refused: check the connection's permissions");
    expect(failureLabel("google_http_404")).toBe("Google could not find this location or post");
  });
  it("prefixed codes keep their detail", () => {
    expect(failureLabel("guardrail_blocked:P.phone,P.cta")).toBe(
      "Blocked by guardrails at send: A phone number in the post text; The button is not valid",
    );
    expect(failureLabel("delete_failed:google_http_403")).toBe(
      "Delete failed: Google refused: check the connection's permissions",
    );
  });
});
