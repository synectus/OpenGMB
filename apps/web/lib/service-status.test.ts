import { describe, expect, it, vi } from "vitest";
import {
  STATUS_CACHE_MS,
  WORKER_STALE_MS,
  createStatusCache,
  toPublicStatus,
  workerState,
} from "./service-status";

const now = new Date("2026-10-20T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const part = (s: ReturnType<typeof toPublicStatus>, k: string) => s.parts.find((p) => p.key === k)!.state;

describe("worker state", () => {
  it("canary: a heartbeat a minute ago is running, one a day ago is delayed, none is not reporting", () => {
    expect(workerState(ago(60_000), now)).toBe("up");
    expect(workerState(ago(24 * 3600_000), now)).toBe("delayed");
    expect(workerState(null, now)).toBe("unknown");
  });
  it("the edge: exactly the limit is still running, one second more is delayed", () => {
    expect(workerState(ago(WORKER_STALE_MS), now)).toBe("up");
    expect(workerState(ago(WORKER_STALE_MS + 1000), now)).toBe("delayed");
  });
});

describe("toPublicStatus", () => {
  it("all well", () => {
    const s = toPublicStatus({ databaseUp: true, workerLastActivityAt: ago(1000) }, now);
    expect(s.parts.map((p) => p.key)).toEqual(["web", "worker", "database"]);
    expect(s.parts.map((p) => p.state)).toEqual(["up", "up", "up"]);
    expect(s.overall).toBe("ok");
  });
  it("a late worker is degraded, not down", () => {
    const s = toPublicStatus({ databaseUp: true, workerLastActivityAt: ago(WORKER_STALE_MS * 2) }, now);
    expect(part(s, "worker")).toBe("delayed");
    expect(s.overall).toBe("degraded");
  });
  it("an unreachable database is down, and the worker is not guessed", () => {
    const s = toPublicStatus(null, now);
    expect(part(s, "database")).toBe("down");
    expect(part(s, "worker")).toBe("unknown");
    expect(s.overall).toBe("down");
  });
  it("carries nothing but keys, labels, states and the check time", () => {
    const s = toPublicStatus({ databaseUp: true, workerLastActivityAt: ago(5) }, now);
    expect(Object.keys(s).sort()).toEqual(["checkedAt", "overall", "parts"]);
    for (const p of s.parts) expect(Object.keys(p).sort()).toEqual(["key", "label", "state"]);
  });
});

describe("createStatusCache", () => {
  const signals = { databaseUp: true, workerLastActivityAt: null };
  it("canary: ten callers in one window cause one read", async () => {
    const read = vi.fn(async () => signals);
    let t = 1_000_000;
    const get = createStatusCache(read, STATUS_CACHE_MS, () => t);
    await Promise.all(Array.from({ length: 10 }, () => get()));
    t += STATUS_CACHE_MS - 1;
    await get();
    expect(read).toHaveBeenCalledTimes(1);
    t += 2;
    await get();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("a failing read becomes 'database down' without leaking the error, and is cached too", async () => {
    const read = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    });
    const get = createStatusCache(read, STATUS_CACHE_MS, () => 5);
    const s = await get();
    await get();
    expect(part(s, "database")).toBe("down");
    expect(JSON.stringify(s)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
