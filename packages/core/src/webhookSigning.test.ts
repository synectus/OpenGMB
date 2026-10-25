import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateWebhookSecret, signWebhook, verifyWebhook } from "./webhooks/signing";

describe("webhook signing (Standard Webhooks)", () => {
  it("generateWebhookSecret is whsec_ + 24 random bytes in base64", () => {
    const s = generateWebhookSecret();
    expect(s.startsWith("whsec_")).toBe(true);
    expect(Buffer.from(s.slice(6), "base64")).toHaveLength(24);
    expect(generateWebhookSecret()).not.toBe(s);
  });

  it("matches a vector computed independently", () => {
    const secret = "whsec_" + Buffer.from("0123456789abcdef01234567").toString("base64");
    const id = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
    const timestamp = 1614265330;
    const body = '{"test": 2432232314}';
    const expected =
      "v1," +
      createHmac("sha256", Buffer.from("0123456789abcdef01234567"))
        .update(`${id}.${timestamp}.${body}`)
        .digest("base64");
    expect(signWebhook({ id, timestamp, body, secret })).toBe(expected);
  });

  it("verifies a correct signature and rejects tampering", () => {
    const secret = generateWebhookSecret();
    const now = 1_800_000_000;
    const input = { id: "d1", timestamp: now, body: '{"a":1}', secret };
    const signature = signWebhook(input);
    expect(verifyWebhook({ ...input, signature, nowSeconds: now })).toBe(true);
    expect(verifyWebhook({ ...input, body: '{"a":2}', signature, nowSeconds: now })).toBe(false);
    expect(verifyWebhook({ ...input, id: "d2", signature, nowSeconds: now })).toBe(false);
    expect(verifyWebhook({ ...input, secret: generateWebhookSecret(), signature, nowSeconds: now })).toBe(false);
  });

  it("rejects a timestamp more than 5 minutes off", () => {
    const secret = generateWebhookSecret();
    const now = 1_800_000_000;
    const input = { id: "d1", timestamp: now, body: "{}", secret };
    const signature = signWebhook(input);
    expect(verifyWebhook({ ...input, signature, nowSeconds: now + 299 })).toBe(true);
    expect(verifyWebhook({ ...input, signature, nowSeconds: now + 301 })).toBe(false);
    expect(verifyWebhook({ ...input, signature, nowSeconds: now - 301 })).toBe(false);
  });

  it("accepts any entry of a space separated signature list", () => {
    const secret = generateWebhookSecret();
    const now = 1_800_000_000;
    const input = { id: "d1", timestamp: now, body: "{}", secret };
    const signature = `v1,AAAA ${signWebhook(input)}`;
    expect(verifyWebhook({ ...input, signature, nowSeconds: now })).toBe(true);
  });
});
