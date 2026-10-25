import { createHmac, randomBytes } from "node:crypto";

// Rate-limit counters never hold a raw IP address. The key is an HMAC of it, salted with BETTER_AUTH_SECRET
// (already required to run the app), or with a random per-process salt when that is unset. Counters live in memory
// and expire with their window (24 hours at most), so the hash is deleted with them.
const fallbackSalt = randomBytes(32).toString("hex");

export function hashIp(ip: string, secret: string | undefined = process.env.BETTER_AUTH_SECRET): string {
  return createHmac("sha256", secret?.trim() || fallbackSalt).update(ip).digest("hex").slice(0, 32);
}
