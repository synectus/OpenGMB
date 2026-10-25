import { describe, expect, it } from "vitest";
import { embedSnippet, EMAIL_TEMPLATE, renderMessage, SMS_TEMPLATE, smsLength, trackedUrl, unknownVariables } from "./review-requests";

describe("trackedUrl", () => {
  it("origin, slug and source; a plain link has no source", () => {
    expect(trackedUrl("https://app.test/", "rivermoor-main", "qr")).toBe("https://app.test/go/rivermoor-main?s=qr");
    expect(trackedUrl("https://app.test", "rivermoor-main", "link")).toBe("https://app.test/go/rivermoor-main");
  });
});

describe("renderMessage and unknownVariables", () => {
  it("canary: only the two known variables are replaced", () => {
    const out = renderMessage(SMS_TEMPLATE, { location_name: "Rivermoor Main St", review_link: "https://app.test/go/x?s=sms" });
    expect(out).toBe("Thanks for choosing Rivermoor Main St. If you have a minute, tell us how we did on Google: https://app.test/go/x?s=sms Reply STOP to opt out.");
    expect(renderMessage("Hi {patient_name} {location_name}", { location_name: "X", review_link: "L" })).toBe("Hi {patient_name} X");
  });
  it("lists unknown variables once each", () => {
    expect(unknownVariables("a {patient_name} {location_name} {patient_name} {visit}")).toEqual(["patient_name", "visit"]);
    expect(unknownVariables(EMAIL_TEMPLATE)).toEqual([]);
  });
});

describe("smsLength", () => {
  it("one segment up to 160, then 153 per segment", () => {
    expect(smsLength("a".repeat(160))).toEqual({ length: 160, segments: 1, limit: 160 });
    expect(smsLength("a".repeat(161))).toEqual({ length: 161, segments: 2, limit: 160 });
    expect(smsLength("a".repeat(307)).segments).toBe(3);
  });
  it("non-GSM characters drop the segment to 70", () => {
    expect(smsLength("é".repeat(70)).segments).toBe(1);
    expect(smsLength("日".repeat(71))).toMatchObject({ segments: 2, limit: 70 });
  });
});

describe("embedSnippet", () => {
  it("is one async script tag with the slug", () => {
    expect(embedSnippet("https://app.test/", "rivermoor-main")).toBe('<script src="https://app.test/widget.js" data-location="rivermoor-main" async></script>');
  });
  it("adds the chosen layout when one is given", () => {
    expect(embedSnippet("https://app.test", "rivermoor-main", "list")).toBe('<script src="https://app.test/widget.js" data-location="rivermoor-main" data-layout="list" async></script>');
  });
});
