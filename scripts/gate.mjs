#!/usr/bin/env node
// pnpm gate: the one local merge gate (GitHub Actions is off). Runs typecheck, lint, unit tests,
// colour check and Playwright against throwaway Postgres databases, and fails on any failing
// step or on a count of zero. Never kills a process; never prints credentials.
//
//   pnpm gate            run everything, drop the throwaway databases at the end
//   pnpm gate --keep     keep the databases (their names are printed)
//   pnpm gate --full     run everything even when the branch changes only documentation
//
// A branch whose changes (against the merge-base with origin/main, plus uncommitted and untracked
// files) are all under docs/ or end in .md (but not .md under apps/web/content/, which is marketing page content) skips every step after this decision and exits 0 with a
// "(docs-only, no tests run)" line. Zero changed files, or any git failure, runs the full gate.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  dbUrlFor,
  docsOnlyDecision,
  findEnvFile,
  findReportLine,
  parsePlaywrightJson,
  parseVitestJson,
  requirePositive,
} from "./gate-lib.mjs";

const PORTS = [3011, 3111, 3211];
const PG_CONTAINER = "syngmb-postgres";
const PG_USER = "syngmb";
const LOCK_DIR = process.env.E2E_LOCK_DIR || path.join(os.tmpdir(), "opengmb-e2e.lock");
const DB_NAME = /^syngmb_gate_\d+_(unit|e2e)$/;

const keep = process.argv.includes("--keep");
const full = process.argv.includes("--full");
// Hidden: select a test filter that matches nothing, to prove the gate fails on zero.
const canaryEmpty = process.argv.includes("--canary-empty");

const root = process.cwd();
const log = (m) => console.log(`\n[gate] ${m}`);
const fail = (m) => {
  console.error(`[gate] ${m}`);
  process.exit(1);
};

// 0. Docs-only branches skip everything below (before the lock, the env and any Postgres use).
const git = (...args) => {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout;
};
const changedFiles = () => {
  const base = git("merge-base", "origin/main", "HEAD").trim();
  const tracked = git("diff", "--name-only", "--no-renames", base).split("\n");
  const untracked = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3));
  return [...new Set([...tracked, ...untracked].filter(Boolean))];
};
if (full) {
  log("full run: --full given");
} else {
  let decision;
  try {
    decision = docsOnlyDecision(changedFiles());
  } catch (e) {
    decision = { docsOnly: false, reason: `full run: could not compute the change set (${e.message})` };
  }
  if (decision.docsOnly) {
    log(`${decision.reason}, tests skipped`);
    log("PASS (docs-only, no tests run)");
    process.exit(0);
  }
  log(decision.reason);
}

// 1. Environment: DATABASE_URL_TEST from .env (cwd, else the main worktree).
const envFile = findEnvFile(root);
const fileEnv = envFile ? parseEnv(readFileSync(envFile, "utf8")) : {};
const baseUrl = process.env.DATABASE_URL_TEST ?? fileEnv.DATABASE_URL_TEST;
if (!baseUrl) fail("DATABASE_URL_TEST is not set in the environment or in .env");
log(`env from ${envFile ?? "process environment"} (values not printed)`);
// DATABASE_URL is deliberately dropped: nothing in the gate may reach a real database by accident.
const childEnvBase = { ...fileEnv, ...process.env };
delete childEnvBase.DATABASE_URL;

// 2. The e2e lock (shared with other agents), held for the whole run. It is taken BEFORE the port
// check: waiting for another gate-aware run is correct, and ports still busy once we hold the lock
// mean the holder is not a gate-aware process, which is a failure.
let haveLock = false;
const releaseLock = () => {
  if (haveLock) {
    try {
      rmdirSync(LOCK_DIR);
    } catch {
      // already gone
    }
    haveLock = false;
  }
};
mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
for (let waited = 0; !haveLock; waited += 10) {
  try {
    mkdirSync(LOCK_DIR);
    haveLock = true;
  } catch {
    if (waited >= 1800) fail(`could not take ${LOCK_DIR} in 30 minutes; someone else is running e2e`);
    if (waited % 60 === 0) log(`waiting for the e2e lock ${LOCK_DIR} ...`);
    spawnSync("sleep", ["10"]);
  }
}

// 3. Ports must be free. Lists PIDs, kills nothing.
const taken = [];
for (const port of PORTS) {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pids = r.stdout.split("\n").filter(Boolean);
  if (pids.length) taken.push(`port ${port}: PID ${pids.join(", ")}`);
}
if (taken.length) {
  releaseLock();
  fail(`ports for e2e are in use (nothing was killed):\n  ${taken.join("\n  ")}`);
}

// 4. Throwaway databases.
const stamp = Date.now();
const unitDb = `syngmb_gate_${stamp}_unit`;
const e2eDb = `syngmb_gate_${stamp}_e2e`;
const created = [];
const pg = (cmd, name) => {
  if (!DB_NAME.test(name)) throw new Error(`refusing to ${cmd} ${name}: not a gate database name`);
  const args = ["exec", PG_CONTAINER, cmd, "-U", PG_USER];
  if (cmd === "dropdb") args.push("--if-exists", "--force");
  return spawnSync("docker", [...args, name], { encoding: "utf8" });
};
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  if (keep) {
    if (created.length) log(`--keep: databases left in place: ${created.join(", ")}`);
  } else {
    for (const name of created) {
      const r = pg("dropdb", name);
      if (r.status !== 0) console.error(`[gate] could not drop ${name}: ${r.stderr.trim()}`);
    }
  }
  releaseLock();
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

const results = [];
const tmp = mkdtempSync(path.join(os.tmpdir(), "syngmb-gate-"));
const step = (name, fn) => {
  log(`${name} ...`);
  try {
    results.push({ name, ok: true, text: fn() });
  } catch (e) {
    results.push({ name, ok: false, text: `FAILED: ${e.message}` });
  }
};
const run = (cmd, args, env = childEnvBase, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", ...opts });
  return r.status === 0;
};

try {
  for (const name of [unitDb, e2eDb]) {
    const r = pg("createdb", name);
    if (r.status !== 0) throw new Error(`createdb ${name} failed: ${r.stderr.trim()}`);
    created.push(name);
  }
  log(`throwaway databases: ${unitDb}, ${e2eDb}`);

  step("typecheck", () => {
    const dry = spawnSync("pnpm", ["exec", "turbo", "run", "typecheck", "--dry=json"], {
      cwd: root,
      env: childEnvBase,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const tasks = JSON.parse(dry.stdout).tasks.filter((t) => t.command !== "<NONEXISTENT>").length;
    if (!run("pnpm", ["typecheck"])) throw new Error("pnpm typecheck exited non-zero");
    return `typecheck ok (${requirePositive("typecheck tasks", tasks)} tasks)`;
  });

  step("lint", () => {
    if (!run("pnpm", ["lint"])) throw new Error("pnpm lint exited non-zero");
    return "lint ok";
  });

  step("unit", () => {
    const out = path.join(tmp, "vitest.json");
    const args = ["exec", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`];
    if (canaryEmpty) args.push("--passWithNoTests", "__no_such_test_file__");
    const env = { ...childEnvBase, DATABASE_URL_TEST: dbUrlFor(baseUrl, unitDb) };
    const ok = run("pnpm", args, env);
    if (!existsSync(out)) throw new Error("vitest wrote no JSON report");
    const { tests, files, failed } = parseVitestJson(readFileSync(out, "utf8"));
    if (!ok || failed) throw new Error(`vitest failed (${failed} failing tests of ${tests})`);
    requirePositive("unit", tests);
    return `unit ${tests} tests in ${files} files`;
  });

  step("colors", () => {
    if (!run("pnpm", ["--filter", "@opengmb/web", "check:colors"])) throw new Error("check:colors failed");
    return "colors ok";
  });

  step("e2e", () => {
    const out = path.join(tmp, "playwright.json");
    const env = {
      ...childEnvBase,
      DATABASE_URL_TEST: dbUrlFor(baseUrl, e2eDb),
      PLAYWRIGHT_JSON_OUTPUT_NAME: out,
    };
    const ok = run("pnpm", ["--filter", "@opengmb/web", "exec", "playwright", "test", "--reporter=json"], env);
    if (!existsSync(out)) throw new Error("playwright wrote no JSON report");
    const { tests, failed, skipped } = parsePlaywrightJson(readFileSync(out, "utf8"));
    if (!ok || failed) throw new Error(`playwright failed (${failed} failing of ${tests})`);
    requirePositive("e2e", tests);
    // W10: the SEO spec prints its summary; its absence means the spec did not run, which must not pass.
    const seo = findReportLine(readFileSync(out, "utf8"), "[seo] ");
    if (!seo) throw new Error("the SEO check did not run (no [seo] summary line in the Playwright report)");
    return `e2e ${tests} tests${skipped ? ` (${skipped} skipped)` : ""} · ${seo.slice(6)}`;
  });
} catch (e) {
  results.push({ name: "setup", ok: false, text: `FAILED: ${e.message}` });
} finally {
  cleanup();
  rmSync(tmp, { recursive: true, force: true });
}

const failedSteps = results.filter((r) => !r.ok);
console.log(`\n[gate] ${results.map((r) => r.text).join(" · ")}`);
console.log(failedSteps.length ? `[gate] FAILED: ${failedSteps.map((r) => r.name).join(", ")}` : "[gate] PASS");
process.exit(failedSteps.length ? 1 : 0);
