import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actions, reviewCreatedPayload } from "@opengmb/core";

/**
 * The REST v1 stability promise. These actions and the review.created payload are what the Zapier
 * integration and customers' own code depend on. A removed or retyped field breaks them; adding a
 * field is allowed (update the snapshot on purpose). Breaking change: plan /v2.
 */
export const STABLE_ACTIONS = [
  "apiTokens.current",
  "reviews.list",
  "workspaces.list",
  "webhooks.subscribe",
  "webhooks.unsubscribe",
] as const;

const SNAPSHOT = "./__snapshots__/rest-v1-contract.json";
const snapshotPath = new URL(SNAPSHOT, import.meta.url);

function currentContract() {
  const out: Record<string, unknown> = {};
  for (const name of STABLE_ACTIONS) {
    const a = actions.find((x) => x.name === name);
    if (!a) throw new Error(`stable action ${name} is missing from the registry`);
    out[name] = {
      kind: a.kind,
      approval: a.approval ?? null,
      input: z.toJSONSchema(a.input, { io: "input", unrepresentable: "any" }),
      output: z.toJSONSchema(a.output, { io: "output", unrepresentable: "any" }),
    };
  }
  out["review.created payload"] = z.toJSONSchema(reviewCreatedPayload, { io: "output", unrepresentable: "any" });
  return out;
}

/** Every path in `before` that is gone from `after`, or whose value changed type or enum. */
export function breakingChanges(before: unknown, after: unknown, at = "$"): string[] {
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length < before.length) return [`${at}: array shrank or changed`];
    return before.flatMap((v, i) => breakingChanges(v, after[i], `${at}[${i}]`));
  }
  if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) return [`${at}: no longer an object`];
    return Object.entries(before).flatMap(([k, v]) =>
      k in after ? breakingChanges(v, (after as Record<string, unknown>)[k], `${at}.${k}`) : [`${at}.${k}: removed`],
    );
  }
  return before === after ? [] : [`${at}: ${JSON.stringify(before)} became ${JSON.stringify(after)}`];
}

describe("REST v1 contract", () => {
  it("canary: the comparison reports a removed field and a retyped field", () => {
    const real = JSON.parse(JSON.stringify(currentContract()));
    expect(breakingChanges(real, real)).toEqual([]);
    const cut = JSON.parse(JSON.stringify(real));
    delete cut["reviews.list"].output.properties.items;
    expect(breakingChanges(real, cut).join("\n")).toContain("reviews.list.output.properties.items: removed");
    const retyped = JSON.parse(JSON.stringify(real));
    retyped["reviews.list"].input.type = "string";
    expect(breakingChanges(real, retyped)).toHaveLength(1);
  });

  it("the stable set stays: no field removed or retyped since the snapshot", () => {
    expect(existsSync(snapshotPath), "snapshot file missing").toBe(true);
    const frozen = JSON.parse(readFileSync(snapshotPath, "utf8"));
    expect(Object.keys(frozen).length).toBe(STABLE_ACTIONS.length + 1);
    const problems = breakingChanges(frozen, JSON.parse(JSON.stringify(currentContract())));
    expect(problems, "breaking change to API v1: make it additive or plan /v2").toEqual([]);
  });

  it("the snapshot matches exactly (an additive change must update it on purpose)", async () => {
    const text = JSON.stringify(currentContract(), null, 2) + "\n";
    console.log(`[rest-contract] ${STABLE_ACTIONS.length} stable actions plus the review.created payload frozen`);
    await expect(text).toMatchFileSnapshot(SNAPSHOT);
  });
});
