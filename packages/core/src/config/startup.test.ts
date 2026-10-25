import { describe, expect, it } from "vitest";
import { StartupConfigError, buildStartupReport, reportStartupConfig } from "./startup";

const key = (n = 32) => Buffer.alloc(n, 7).toString("base64");
const good = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://dbuser:s3cretPassw0rd@db.internal:5432/syngmb",
  ENCRYPTION_KEY: key(32),
  AUDIT_CHECKPOINT_KEY: key(32),
  BETTER_AUTH_SECRET: "b".repeat(40),
  BETTER_AUTH_URL: "https://opengmb.example.com",
  GOOGLE_BUSINESS_API_MODE: "live",
  GOOGLE_BUSINESS_WRITES: "off",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret-value",
  RESEND_API_KEY: "re_secretkeyvalue",
};

describe("startup config report", () => {
  it("DATAFORSEO_API_BASE: empty or a known host is fine, anything else is a problem; keys never printed", () => {
    expect(buildStartupReport("web", { ...good, DATAFORSEO_API_BASE: "" }).problems).toEqual([]);
    expect(
      buildStartupReport("web", { ...good, DATAFORSEO_API_BASE: "https://sandbox.dataforseo.com" }).problems,
    ).toEqual([]);
    const bad = buildStartupReport("web", { ...good, DATAFORSEO_API_BASE: "https://evil.example" });
    expect(bad.problems.join()).toContain("DATAFORSEO_API_BASE");
    const r = buildStartupReport("worker", { ...good, DATAFORSEO_PASSWORD: "dfs-pw-value", GOOGLE_PLACES_SERVER_KEY: "pk-value" });
    expect(r.secrets.DATAFORSEO_PASSWORD).toBe("present");
    expect(r.secrets.GOOGLE_PLACES_SERVER_KEY).toBe("present");
    expect(r.lines.join("\n")).not.toMatch(/dfs-pw-value|pk-value/);
  });

  it("prints mode, writes and URLs, and never a secret value or the database credentials", () => {
    const out: string[] = [];
    for (const service of ["web", "worker", "mcp"] as const) {
      reportStartupConfig(service, good, (l) => out.push(l));
    }
    const text = out.join("\n");
    expect(text).toContain("google_mode=live");
    expect(text).toContain("google_writes=off");
    expect(text).toContain("signup=open");
    const closed: string[] = [];
    reportStartupConfig("web", { ...good, SIGNUP_MODE: "invite_only" }, (l) => closed.push(l));
    expect(closed.join("\n")).toContain("signup=invite_only");
    // G9: only the size of the platform-admin allowlist is printed, never the addresses.
    expect(text).toContain("platform_admins=0");
    const admins: string[] = [];
    reportStartupConfig("web", { ...good, PLATFORM_ADMIN_EMAILS: " A@x.test, a@X.test ,b@x.test" }, (l) =>
      admins.push(l),
    );
    expect(admins.join("\n")).toContain("platform_admins=2");
    expect(admins.join("\n")).not.toContain("x.test");
    // H1a: the effective abuse-protection settings are readable from the running process.
    expect(text).toContain("email_verification=required");
    expect(text).toContain("lockout=10_failures_per_15_min");
    expect(text).toContain("public_per_min=share:60,review-link:60,widget:120,image:300");
    const noVerify: string[] = [];
    reportStartupConfig(
      "web",
      { ...good, REQUIRE_EMAIL_VERIFICATION: "false", AUTH_LOCKOUT_FAILURES: "5" },
      (l) => noVerify.push(l),
    );
    expect(noVerify.join("\n")).toContain("email_verification=off");
    expect(noVerify.join("\n")).toContain("lockout=5_failures_per_15_min");
    expect(text).toContain("base_url=https://opengmb.example.com");
    expect(text).toContain("database=db.internal:5432/syngmb");
    expect(text).toContain("BETTER_AUTH_SECRET=present");
    // The denominator: three services, each printed.
    expect(
      out.filter((l) => l.includes("secrets ENCRYPTION") || l.includes("secrets DATABASE")).length,
    ).toBe(3);
    for (const secret of [
      "s3cretPassw0rd",
      "dbuser",
      good.ENCRYPTION_KEY,
      good.BETTER_AUTH_SECRET,
      good.GOOGLE_CLIENT_SECRET,
      good.RESEND_API_KEY,
    ]) {
      expect(text, `leaked ${secret.slice(0, 6)}...`).not.toContain(secret);
    }
  });

  it("fails fast, listing every missing required secret at once", () => {
    const env = { ...good, ENCRYPTION_KEY: undefined, BETTER_AUTH_SECRET: "" };
    const log: string[] = [];
    let err: unknown;
    try {
      reportStartupConfig("web", env, (l) => log.push(l));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StartupConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain("ENCRYPTION_KEY is not set");
    expect(msg).toContain("BETTER_AUTH_SECRET is not set");
    expect(msg).toContain("hosting provider");
    // The config was still printed before failing, so the log shows what the process saw.
    expect(log.join("\n")).toContain("ENCRYPTION_KEY=missing");
  });

  it("only requires BETTER_AUTH_SECRET of the web service", () => {
    const env = { ...good, BETTER_AUTH_SECRET: undefined };
    expect(buildStartupReport("web", env).problems).toEqual(["BETTER_AUTH_SECRET is not set"]);
    expect(buildStartupReport("worker", env).problems).toEqual([]);
    expect(buildStartupReport("mcp", env).problems).toEqual([]);
  });

  it("rejects unusable values, not just absent ones", () => {
    const short = buildStartupReport("mcp", { ...good, ENCRYPTION_KEY: key(16) });
    expect(short.problems).toEqual(["ENCRYPTION_KEY must be base64 for exactly 32 bytes"]);
    expect(short.secrets.ENCRYPTION_KEY).toBe("invalid");
    const placeholder = buildStartupReport("web", {
      ...good,
      BETTER_AUTH_SECRET: "replace-with-random-string",
    });
    expect(placeholder.problems.join()).toContain("placeholder");
    // The placeholder is only refused in production; development keeps working from .env.example.
    const dev = buildStartupReport("web", {
      ...good,
      NODE_ENV: "development",
      BETTER_AUTH_SECRET: "replace-with-random-string-xxxxxxxxxxxxxxxx",
    });
    expect(dev.problems).toEqual([]);
  });

  it("live Google mode also needs the Google client credentials", () => {
    const env = { ...good, GOOGLE_CLIENT_SECRET: undefined };
    expect(buildStartupReport("worker", env).problems).toEqual(["GOOGLE_CLIENT_SECRET is not set"]);
    expect(
      buildStartupReport("worker", { ...env, GOOGLE_BUSINESS_API_MODE: "mock" }).problems,
    ).toEqual([]);
  });

  it("rejects a mode or writes flag that the Google client factory would reject later", () => {
    expect(
      buildStartupReport("web", { ...good, GOOGLE_BUSINESS_API_MODE: "lvie" }).problems.join(),
    ).toContain("must be mock or live");
    expect(
      buildStartupReport("web", { ...good, GOOGLE_BUSINESS_WRITES: "on" }).problems.join(),
    ).toContain("must be off or live");
  });

  it("warns when production runs the mock Google client", () => {
    const r = buildStartupReport("web", { ...good, GOOGLE_BUSINESS_API_MODE: "mock" });
    expect(r.lines.join("\n")).toContain(
      "WARNING production is running with GOOGLE_BUSINESS_API_MODE=mock",
    );
  });

  it("the worker prints its effective webhook settings", () => {
    const r = buildStartupReport("worker", good);
    expect(r.lines.join("\n")).toContain("webhooks: retry_limit=8 max_age_days=14 retention_days=30");
    expect(buildStartupReport("web", good).lines.join("\n")).not.toContain("webhooks: retry_limit");
  });
});
