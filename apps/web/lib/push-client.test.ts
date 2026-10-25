import { describe, expect, it } from "vitest";
import { parseSubscriptionBody, urlBase64ToUint8Array } from "./push-client";

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url with and without padding", () => {
    expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array("-_8")]).toEqual([251, 255]);
  });
});

describe("parseSubscriptionBody", () => {
  const ok = { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } };
  it("canary: a browser subscription is accepted", () => {
    expect(parseSubscriptionBody(ok)).toEqual({ endpoint: ok.endpoint, p256dh: "p", auth: "a" });
  });
  it("rejects anything else", () => {
    for (const b of [null, "x", {}, { endpoint: 1, keys: ok.keys }, { endpoint: ok.endpoint }, { endpoint: ok.endpoint, keys: { p256dh: "", auth: "a" } }]) {
      expect(parseSubscriptionBody(b)).toBeNull();
    }
  });
});
