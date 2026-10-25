// Runs once when the server process starts (not during `next build`). Prints the effective
// non-secret config and refuses to start when a required secret is missing; see
// packages/core/src/config/startup.ts. Also starts the H2 monitors: a check that the worker is
// still sending its heartbeat, and (below) the hook that records unhandled server errors.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { reportStartupConfig, MONITORING, checkWorker, startIntegrations, bootstrapOwner, isCommunity } = await import("@opengmb/core");
  reportStartupConfig("web");

  // Self-hosted first start: create the organization and owner from OWNER_EMAIL / OWNER_PASSWORD (the
  // migrations ran before web started). Does nothing once an organization exists.
  if (isCommunity() && process.env.DATABASE_URL) {
    try {
      const { getDb } = await import("./lib/auth");
      await bootstrapOwner(getDb());
    } catch (e) {
      console.error("[bootstrap] failed", e instanceof Error ? e.message : e);
    }
  }

  // In-app integration keys (Settings > Integrations): load them, say where each key comes from,
  // and reload every minute so a key saved by another process is picked up.
  if (process.env.DATABASE_URL) {
    try {
      const { getDb } = await import("./lib/auth");
      await startIntegrations("web", getDb());
    } catch (e) {
      console.error("[integrations] start failed", e instanceof Error ? e.message : e);
    }
  }

  // The worker cannot report its own death, so the web server watches the heartbeat. One timer
  // per process (a dev reload runs register again); replicas are safe, the alert is claimed in SQL.
  const g = globalThis as { __syngmbWorkerWatch?: boolean };
  if (g.__syngmbWorkerWatch || !process.env.DATABASE_URL) return;
  g.__syngmbWorkerWatch = true;
  setInterval(async () => {
    try {
      const { getDb } = await import("./lib/auth");
      await checkWorker(getDb());
    } catch (e) {
      console.error("[monitoring] worker check failed", e instanceof Error ? e.message : e);
    }
  }, MONITORING.webCheckMs).unref();
}

// Next calls this for every unhandled error while rendering or handling a request.
export async function onRequestError(err: unknown) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recordError, toErrorInfo } = await import("@opengmb/core");
    const { getDb } = await import("./lib/auth");
    await recordError(getDb(), "web", toErrorInfo(err));
  } catch {
    // Reporting an error must never raise another one.
  }
}
