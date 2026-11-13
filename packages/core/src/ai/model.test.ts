import { afterEach, describe, expect, it } from "vitest";
import { aiIsOn, getAiModel, setAiTestOverrides } from "./model";

afterEach(() => setAiTestOverrides({}));
const REQ = { model: "m", system: "s", user: "u", maxTokens: 100 } as never;

describe("AI_API_MODE=mock (e2e only)", () => {
  it("answers fixed text with small token counts when both mock flags are set outside production", async () => {
    const m = getAiModel({ AI_API_MODE: "mock", GOOGLE_BUSINESS_API_MODE: "mock", NODE_ENV: "development" });
    expect(m).not.toBeNull();
    const r = await m!(REQ);
    expect(r.text).toBe("Thank you for your review. We are glad you visited and hope to see you again.");
    expect(r.inputTokens).toBeGreaterThan(0);
    expect(r.inputTokens).toBeLessThan(5000);
    expect(r.outputTokens).toBeGreaterThan(0);
  });

  it("is null without the Google mock flag (no key, no mock)", () => {
    expect(getAiModel({ AI_API_MODE: "mock", NODE_ENV: "development" })).toBeNull();
  });

  it("is null in production even when both mock flags are set: production runs live Google, so the mock is unreachable there", () => {
    expect(getAiModel({ AI_API_MODE: "mock", GOOGLE_BUSINESS_API_MODE: "mock", NODE_ENV: "production" })).toBeNull();
  });

  it("canary: a real key still gives a model and no flags give none", () => {
    expect(getAiModel({ ANTHROPIC_API_KEY: "k" })).not.toBeNull();
    expect(getAiModel({})).toBeNull();
  });

  it("aiIsOn ignores the mock, so no other page shows AI buttons in e2e", () => {
    expect(aiIsOn({ AI_API_MODE: "mock", GOOGLE_BUSINESS_API_MODE: "mock", NODE_ENV: "development" })).toBe(false);
  });
});
