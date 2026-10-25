import { afterAll, describe, expect, it } from "vitest";
import { generate } from "otplib";
import { createDb } from "@opengmb/db";
import { BACKUP_CODE_COUNT, countBackupCodes, createAuth, type Auth } from "./auth";
import { AuthError, requireAuthenticatedUser } from "./session";

// Pins the Better-Auth 1.7.7 behaviour /account is built on, so a library upgrade that changes
// it fails here and not in front of a user.
const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

const BASE = "http://localhost:3000";
const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-123", baseURL: BASE });

type Body = {
  totpURI?: string;
  backupCodes?: string[];
  twoFactorRedirect?: boolean;
  code?: string;
};

/** Minimal cookie jar over a real Better-Auth instance (same shape as auth.test.ts). */
class Client {
  constructor(private readonly a: Auth = auth) {}
  private jar = new Map<string, string>();
  async post(path: string, body: unknown) {
    const res = await this.a.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie: this.cookie() },
        body: JSON.stringify(body),
      }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return { res, json: (await res.json().catch(() => null)) as Body | null };
  }
  cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  session() {
    return this.a.api.getSession({ headers: new Headers({ cookie: this.cookie() }) });
  }
}

const totp = (uri: string) =>
  generate({ secret: new URL(uri).searchParams.get("secret")!, strategy: "totp" });

function gate(s: Awaited<ReturnType<Client["session"]>>): string {
  try {
    requireAuthenticatedUser(s);
    return "ok";
  } catch (e) {
    return e instanceof AuthError ? e.code : `other:${String(e)}`;
  }
}

/** A password user with TOTP enrolled and verified. */
async function enrolled() {
  const email = `acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "correct-horse-battery-staple";
  const c = new Client();
  expect((await c.post("/sign-up/email", { name: "Acct", email, password })).res.status).toBe(200);
  const enable = await c.post("/two-factor/enable", { password });
  const uri = enable.json!.totpURI!;
  expect((await c.post("/two-factor/verify-totp", { code: await totp(uri) })).res.status).toBe(200);
  const s = await c.session();
  expect(gate(s)).toBe("ok");
  return { c, email, password, uri, userId: s!.user.id, codes: enable.json!.backupCodes! };
}

describe("backup codes", () => {
  it("enable hands out BACKUP_CODE_COUNT codes and countBackupCodes reads the same number", async () => {
    expect(BACKUP_CODE_COUNT).toBe(10);
    const u = await enrolled();
    expect(u.codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(await countBackupCodes(auth, u.userId)).toBe(BACKUP_CODE_COUNT);
  });

  it("a used code is gone; new codes need the password and replace the whole set", async () => {
    const u = await enrolled();
    expect((await u.c.post("/two-factor/verify-backup-code", { code: u.codes[0] })).res.status).toBe(200);
    expect(await countBackupCodes(auth, u.userId)).toBe(BACKUP_CODE_COUNT - 1);

    expect((await u.c.post("/two-factor/generate-backup-codes", {})).res.status).toBe(400);
    const wrong = await u.c.post("/two-factor/generate-backup-codes", { password: "nope-nope-nope" });
    expect(wrong.res.status).toBe(400);
    expect(wrong.json!.code).toBe("INVALID_PASSWORD");

    const fresh = await u.c.post("/two-factor/generate-backup-codes", { password: u.password });
    expect(fresh.res.status).toBe(200);
    expect(fresh.json!.backupCodes).toHaveLength(BACKUP_CODE_COUNT);
    expect(await countBackupCodes(auth, u.userId)).toBe(BACKUP_CODE_COUNT);
    // An old code no longer works.
    expect((await u.c.post("/two-factor/verify-backup-code", { code: u.codes[1] })).res.status).toBe(401);
  });
});

describe("reset authenticator app = disable, then the normal setup", () => {
  it("disable sends the person to setup (MFA_REQUIRED); enrolling again gives a new secret and full codes", async () => {
    const u = await enrolled();
    expect((await u.c.post("/two-factor/disable", { password: u.password })).res.status).toBe(200);
    expect(gate(await u.c.session())).toBe("MFA_REQUIRED");

    const again = await u.c.post("/two-factor/enable", { password: u.password });
    expect(again.res.status).toBe(200);
    expect(again.json!.totpURI).not.toBe(u.uri);
    await u.c.post("/two-factor/verify-totp", { code: await totp(again.json!.totpURI!) });
    expect(gate(await u.c.session())).toBe("ok");
    expect(await countBackupCodes(auth, u.userId)).toBe(BACKUP_CODE_COUNT);
  });

  it("enable on an enrolled account is refused, which is why reset goes through disable (canary)", async () => {
    const u = await enrolled();
    const r = await u.c.post("/two-factor/enable", { password: u.password });
    expect(r.res.status).toBe(400);
    expect(r.json!.code).toBe("TOTP_ALREADY_ENABLED");
  });
});

describe("change password", () => {
  it("a wrong current password is INVALID_PASSWORD; revokeOtherSessions ends the other device and keeps this one", async () => {
    const u = await enrolled();
    const other = new Client();
    const signIn = await other.post("/sign-in/email", { email: u.email, password: u.password });
    expect(signIn.json!.twoFactorRedirect).toBe(true);
    await other.post("/two-factor/verify-totp", { code: await totp(u.uri) });
    expect(gate(await other.session())).toBe("ok");

    const wrong = await u.c.post("/change-password", {
      currentPassword: "nope-nope-nope",
      newPassword: "another-correct-horse",
      revokeOtherSessions: true,
    });
    expect(wrong.res.status).toBe(400);
    expect(wrong.json!.code).toBe("INVALID_PASSWORD");

    const ok = await u.c.post("/change-password", {
      currentPassword: u.password,
      newPassword: "another-correct-horse",
      revokeOtherSessions: true,
    });
    expect(ok.res.status).toBe(200);
    expect(gate(await u.c.session())).toBe("ok");
    expect(await other.session()).toBeNull();
  });
});
