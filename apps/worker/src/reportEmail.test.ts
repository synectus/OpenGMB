import { describe, expect, it } from "vitest";
import { renderReportEmail } from "./reports";

const base = {
  name: "Rivermoor, monthly",
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  url: "https://app.example.test/r/token",
  expiresAt: new Date("2026-10-31T00:00:00Z"),
};

describe("renderReportEmail", () => {
  it("says performance report by default", () => {
    const m = renderReportEmail(base);
    expect(m.subject).toBe("Performance report: Rivermoor, monthly (2026-09-01 to 2026-09-30)");
    expect(m.text).toContain("Your performance report");
  });
  it("says review report for a reviews report", () => {
    const m = renderReportEmail({ ...base, kind: "reviews" });
    expect(m.subject).toBe("Review report: Rivermoor, monthly (2026-09-01 to 2026-09-30)");
    expect(m.text).toContain("Your review report");
    expect(m.html).toContain("Your review report");
  });
  it("puts the AI summary first, escaped, and leaves it out when there is none", () => {
    const m = renderReportEmail({ ...base, summary: "Calls rose from 5 to 10 <b>." });
    expect(m.text.indexOf("Calls rose from 5 to 10 <b>.")).toBeGreaterThan(0);
    expect(m.text.indexOf("Calls rose")).toBeLessThan(m.text.indexOf("Open the report"));
    expect(m.html).toContain("<p>Calls rose from 5 to 10 &lt;b&gt;.</p>");
    expect(renderReportEmail({ ...base, summary: null }).html).toBe(renderReportEmail(base).html);
    expect(renderReportEmail(base).text).not.toContain("Calls rose");
  });
});
