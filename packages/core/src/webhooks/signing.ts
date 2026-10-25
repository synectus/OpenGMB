import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from "../config/webhooks";

/**
 * Standard Webhooks (https://www.standardwebhooks.com). Headers: `webhook-id`, `webhook-timestamp`
 * (Unix seconds), `webhook-signature` = `v1,<base64 HMAC-SHA256(key, id.timestamp.body)>`. The key
 * is the base64-decoded part of the secret after `whsec_`, as in the reference libraries.
 */
const PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return PREFIX + randomBytes(24).toString("base64");
}

const keyOf = (secret: string) => Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, "base64");

export function signWebhook(input: { id: string; timestamp: number; body: string; secret: string }): string {
  const mac = createHmac("sha256", keyOf(input.secret))
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest("base64");
  return `v1,${mac}`;
}

/** For tests and the help article sample. `signature` may hold several space separated entries. */
export function verifyWebhook(input: {
  id: string;
  timestamp: number;
  body: string;
  secret: string;
  signature: string;
  nowSeconds?: number;
}): boolean {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - input.timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhook(input));
  return input.signature.split(" ").some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
