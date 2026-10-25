import { describe, expect, it } from "vitest";
import { BUSINESS_MANAGE_SCOPE, GOOGLE_OAUTH_BRAND } from "@opengmb/core";
import { BUSINESS_SCOPE, GOOGLE_APP_NAME, connectionSummary, googleCallbackError, scopeLabels } from "./google-connection";

describe("googleCallbackError", () => {
  it("uses the canvas copy for the five callback errors it draws", () => {
    expect(googleCallbackError("missing_scope").text).toBe(
      "Tick the Business Profile box on Google’s consent screen, then try again.",
    );
    expect(googleCallbackError("access_denied").text).toBe("You cancelled on Google’s screen.");
    expect(googleCallbackError("invalid_state").text).toBe(
      "The sign-in took too long or came from another tab. Try again.",
    );
    expect(googleCallbackError("missing_refresh_token").text).toBe(
      `Google did not give lasting access. Remove ${GOOGLE_APP_NAME} from your Google account’s third-party access, then connect again.`,
    );
    expect(googleCallbackError("exchange_failed").text).toBe("Google did not answer. Try again in a minute.");
    expect(googleCallbackError("userinfo_failed").text).toBe("Google did not answer. Try again in a minute.");
  });

  it("keeps the code, and says something for codes it does not know", () => {
    expect(googleCallbackError("forbidden")).toEqual({
      code: "forbidden",
      text: "You do not have permission to connect Google accounts.",
    });
    expect(googleCallbackError("teapot")).toEqual({ code: "teapot", text: "Could not connect Google. Try again." });
  });
});

describe("scopeLabels", () => {
  it("canary: the business scope string is core's", () => {
    expect(BUSINESS_SCOPE).toBe(BUSINESS_MANAGE_SCOPE);
  });

  it("names the business scope, drops openid, keeps unknown scopes as written", () => {
    expect(scopeLabels(["openid", "https://www.googleapis.com/auth/userinfo.email", BUSINESS_SCOPE])).toBe(
      "Business Profile, Email address",
    );
    expect(scopeLabels(["email", "https://example.test/x"])).toBe("Email address, https://example.test/x");
    expect(scopeLabels([])).toBe("None");
  });
});

describe("connectionSummary", () => {
  const loc = (googleLocationId: string | null, needsRelink = false) => ({ googleLocationId, needsRelink });

  it("counts accounts, imported locations and the ones to re-link", () => {
    expect(connectionSummary(1, [loc("a"), loc("b"), loc(null), loc("c", true)])).toBe(
      "1 Google account · 3 locations imported · 1 not linked to Google",
    );
  });

  it("uses singular and plural, and leaves out a zero relink count", () => {
    expect(connectionSummary(2, [loc("a")])).toBe("2 Google accounts · 1 location imported");
    expect(connectionSummary(1, [])).toBe("1 Google account · 0 locations imported");
  });
});

it("GOOGLE_APP_NAME is core's GOOGLE_OAUTH_BRAND.appName (pinned, like BUSINESS_SCOPE)", () => {
  expect(GOOGLE_APP_NAME).toBe(GOOGLE_OAUTH_BRAND.appName.value);
});
