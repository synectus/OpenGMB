import { mkdirSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { PORTS, serverEnv } from "../playwright.config";
import { STATE_DIR } from "./support";

const REPO = path.resolve(STATE_DIR, "../../../..");

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`${url} did not become healthy within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function globalSetup() {
  mkdirSync(STATE_DIR, { recursive: true });
  // The web server (started by Playwright after the database was wiped) creates the owner on its first start.
  const owner = spawnSync("pnpm", ["exec", "tsx", "e2e-community/wait-owner.ts"], { cwd: path.join(REPO, "apps/web"), env: serverEnv, stdio: "inherit" });
  if (owner.status !== 0) throw new Error(`the owner was not created (exit ${owner.status})`);

  // The worker runs the jobs behind imports and reports. Its own process group lets teardown stop tsx and node by PID.
  const worker: ChildProcess = spawn("pnpm", ["exec", "tsx", "--env-file-if-exists=../../.env", "src/index.ts"], {
    cwd: path.join(REPO, "apps/worker"),
    env: { ...serverEnv, NODE_OPTIONS: `${serverEnv.NODE_OPTIONS ?? ""} --require ${path.join(REPO, "scripts/block-public-network.cjs")}`.trim() },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(`http://localhost:${PORTS.worker}/healthz`, 60_000);

  return async () => {
    if (worker.pid) process.kill(-worker.pid, "SIGTERM");
  };
}
