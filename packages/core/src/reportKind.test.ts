import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog } from "@opengmb/db";
import { executeAction } from "./executor";
import { db, makeOrg, sql } from "./performance-fixture";

type Def = { id: string; kind: string };
afterAll(async () => {
  await sql.end();
});

describe("report definition kind", () => {
  it("defaults to performance, accepts reviews, is listed and audited, and cannot change", async () => {
    const o = await makeOrg();
    const base = {
      workspaceId: o.wsA,
      scope: "workspace",
      locationIds: [],
      period: "last_month",
      customFrom: null,
      customTo: null,
      schedule: "none",
      recipients: [],
      branding: {},
    };
    const perf = (await executeAction(db, o.manager, "reports.definitions.create", {
      ...base,
      name: "Perf",
    })) as { definition: Def };
    expect(perf.definition.kind).toBe("performance");

    const rev = (await executeAction(db, o.manager, "reports.definitions.create", {
      ...base,
      name: "Reviews",
      kind: "reviews",
    })) as { definition: Def };
    expect(rev.definition.kind).toBe("reviews");

    const list = (await executeAction(db, o.manager, "reports.definitions.list", {})) as {
      definitions: Def[];
    };
    expect(list.definitions.find((d) => d.id === rev.definition.id)?.kind).toBe("reviews");

    const upd = (await executeAction(db, o.manager, "reports.definitions.update", {
      id: rev.definition.id,
      name: "Reviews renamed",
      kind: "performance",
    })) as { definition: Def };
    expect(upd.definition.kind).toBe("reviews");

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, o.orgId),
          eq(auditLog.action, "reports.definition_created"),
          eq(auditLog.entityId, rev.definition.id),
        ),
      );
    expect(rows[0]!.after).toMatchObject({ kind: "reviews" });
  });

  it("refuses an unknown kind", async () => {
    const o = await makeOrg();
    await expect(
      executeAction(db, o.manager, "reports.definitions.create", {
        workspaceId: o.wsA,
        name: "X",
        scope: "workspace",
        locationIds: [],
        period: "last_month",
        customFrom: null,
        customTo: null,
        schedule: "none",
        recipients: [],
        branding: {},
        kind: "weather",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
