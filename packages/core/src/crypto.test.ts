import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";

const original = process.env.ENCRYPTION_KEY;
afterEach(() => {
  process.env.ENCRYPTION_KEY = original;
});

describe("crypto", () => {
  it("round-trips and uses the v1 format", () => {
    const ct = encryptSecret("refresh-token-é");
    expect(ct).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(decryptSecret(ct)).toBe("refresh-token-é");
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("throws with the wrong key", () => {
    const ct = encryptSecret("secret");
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(() => decryptSecret(ct)).toThrow();
  });

  it("throws on tampered ciphertext", () => {
    const [v, iv, tag, ct] = encryptSecret("secret").split(":") as [string, string, string, string];
    const bytes = Buffer.from(ct, "base64");
    bytes[0] = bytes[0]! ^ 1;
    expect(() => decryptSecret([v, iv, tag, bytes.toString("base64")].join(":"))).toThrow();
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
