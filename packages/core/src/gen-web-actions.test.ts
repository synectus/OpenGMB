import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { actions } from "./actions";
import { communityActions, renderWebActions } from "./gen-web-actions";
import { PRIVATE_ACTIONS } from "./actions/private";
import { toolNameFor } from "./registry";

const committed = fileURLToPath(
  new URL("../../../apps/web/app/_generated/actions.ts", import.meta.url),
);

const communityCommitted = fileURLToPath(
  new URL("../../../oss/apps/web/app/_generated/actions.ts", import.meta.url),
);

describe("generated web actions", () => {
  it("apps/web/app/_generated/actions.ts is up to date with the registry", () => {
    expect(actions.length).toBeGreaterThan(0);
    const expected = renderWebActions(actions);
    const onDisk = readFileSync(committed, "utf8");
    if (onDisk !== expected) {
      throw new Error("apps/web/app/_generated/actions.ts is stale: run pnpm gen:actions");
    }
    for (const a of actions) expect(onDisk).toContain(`function ${toolNameFor(a.name)}(`);
    console.log(`generated file covers ${actions.length} actions`);
  });

  it("canary: the staleness comparison fails when an action is missing", () => {
    const onDisk = readFileSync(committed, "utf8");
    expect(renderWebActions(actions.slice(1))).not.toBe(onDisk);
  });

  it("oss/apps/web/app/_generated/actions.ts is the registry minus the private actions, and up to date", () => {
    const list = communityActions(actions);
    expect(PRIVATE_ACTIONS.length).toBeGreaterThan(0); // canary: the private list is not empty here
    expect(list.length).toBe(actions.length - PRIVATE_ACTIONS.length);
    const onDisk = readFileSync(communityCommitted, "utf8");
    if (onDisk !== renderWebActions(list)) throw new Error("oss/apps/web/app/_generated/actions.ts is stale: run pnpm gen:actions");
    for (const a of PRIVATE_ACTIONS) expect(onDisk).not.toContain(`function ${toolNameFor(a.name)}(`);
    console.log(`community generated file covers ${list.length} of ${actions.length} actions, ${PRIVATE_ACTIONS.length} private left out`);
  });
});
