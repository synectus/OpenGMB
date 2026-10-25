import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  createDb,
  locations,
  memberships,
  organizations,
  reviews,
  users,
  workspaces,
} from "@opengmb/db";
import { loadActor, type Actor } from "./actor";
import { CoreError } from "./errors";
import { executeAction } from "./executor";
import { replyPolicy } from "./reviews/reply-policy";
import {
  isGenericTemplate,
  renderTemplate,
  reviewerFirstName,
  TemplateRenderError,
  validateTemplateBody,
} from "./reviews/templates";
import {
  applyProfileDefaults,
  decideApproval,
  DEFAULT_WORKSPACE_REPLY_SETTINGS,
  getWorkspaceReplySettings,
  type WorkspaceReplySettings,
} from "./reviews/workspace-settings";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
afterAll(() => sql.end());

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof CoreError ? e.code : `other:${String(e)}`;
  }
  return "no error";
}
async function errOf(p: Promise<unknown>): Promise<CoreError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CoreError) return e;
    throw e;
  }
  throw new Error("expected an error");
}

const run = (actor: Actor, name: string, input: unknown = {}) =>
  executeAction(db, actor, name, input);

type Settings = {
  workspaceId: string;
  profile: string;
  packs: string[];
  skipPositiveReviews: boolean;
  genericTemplatesOnly: boolean;
  staffNames: string[];
  autoApproveMinStars: 4 | 5 | null;
  autoPublish: boolean;
  h2Severity: "block" | "warn";
};
type Template = { id: string; name: string; body: string; generic: boolean; workspaceId: string };

async function makeOrg() {
  const [org] = await db
    .insert(organizations)
    .values({ name: `org-${uniq()}` })
    .returning();
  const orgId = org!.id;
  const [a, b] = await db
    .insert(workspaces)
    .values([
      { orgId, name: "A" },
      { orgId, name: "B" },
    ])
    .returning();
  const mkUser = async (
    role: "owner" | "admin" | "manager" | "client_approver" | "client_viewer",
    workspaceId?: string,
  ) => {
    const id = `u-${uniq()}`;
    await db.insert(users).values({ id, name: "T", email: `${id}@example.test` });
    await db.insert(memberships).values({ orgId, userId: id, role, workspaceId });
    return loadActor(db, { userId: id, surface: "ui", actorType: "user" });
  };
  const mkLoc = async (
    workspaceId: string,
    name: string,
    extra: { title?: string; phone?: string } = {},
  ) => {
    const [l] = await db
      .insert(locations)
      .values({ orgId, workspaceId, name, ...extra })
      .returning();
    return l!;
  };
  return {
    orgId,
    a: a!.id,
    b: b!.id,
    owner: await mkUser("owner"),
    admin: await mkUser("admin"),
    manager: await mkUser("manager"),
    approver: await mkUser("client_approver", a!.id),
    viewer: await mkUser("client_viewer", a!.id),
    mkLoc,
  };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;

let seq = 0;
async function mkReview(
  loc: { id: string; orgId: string; workspaceId: string },
  o: { rating?: number | null; name?: string | null; anonymous?: boolean; reply?: string } = {},
) {
  const t = new Date("2026-09-01T00:00:00Z");
  const [r] = await db
    .insert(reviews)
    .values({
      orgId: loc.orgId,
      workspaceId: loc.workspaceId,
      locationId: loc.id,
      googleReviewName: `accounts/1/locations/1/reviews/s${uniq()}-${seq++}`,
      reviewerDisplayName: o.name === undefined ? "Jane Doe" : o.name,
      reviewerIsAnonymous: o.anonymous ?? false,
      starRating: o.rating === undefined ? 5 : o.rating,
      comment: "text",
      createTime: new Date(t.getTime() + seq * 1000),
      updateTime: t,
      replyComment: o.reply ?? null,
    })
    .returning();
  return r!;
}

describe("applyProfileDefaults (G4)", () => {
  it("healthcare: hipaa, skip positive, generic templates only", () => {
    expect(applyProfileDefaults("healthcare")).toEqual({
      profile: "healthcare",
      packs: ["hipaa"],
      skipPositiveReviews: true,
      genericTemplatesOnly: true,
    });
  });
  it("legal turns on legal_ethics; general adds nothing; universal is never stored", () => {
    expect(applyProfileDefaults("legal").packs).toEqual(["legal_ethics"]);
    expect(applyProfileDefaults("general")).toEqual({
      profile: "general",
      packs: [],
      skipPositiveReviews: false,
      genericTemplatesOnly: false,
    });
    for (const p of ["general", "healthcare", "legal"] as const) {
      expect(applyProfileDefaults(p).packs).not.toContain("universal");
    }
  });
});

describe("decideApproval with real settings (R4)", () => {
  const s = (o: Partial<WorkspaceReplySettings>): WorkspaceReplySettings => ({
    ...DEFAULT_WORKSPACE_REPLY_SETTINGS,
    ...o,
  });
  it("defaults are always manual", () => {
    for (const r of [null, 1, 3, 4, 5]) {
      expect(decideApproval(s({}), r)).toEqual({ autoApprove: false, autoPublish: false });
    }
  });
  it("min 4 auto-approves 4 and 5 but never 3", () => {
    expect(decideApproval(s({ autoApproveMinStars: 4 }), 4).autoApprove).toBe(true);
    expect(decideApproval(s({ autoApproveMinStars: 4 }), 5).autoApprove).toBe(true);
    expect(decideApproval(s({ autoApproveMinStars: 4 }), 3).autoApprove).toBe(false);
    expect(decideApproval(s({ autoApproveMinStars: 5 }), 4).autoApprove).toBe(false);
    expect(decideApproval(s({ autoApproveMinStars: 5 }), 5).autoApprove).toBe(true);
  });
  it("autoPublish only applies together with autoApprove, never for 1-3 stars", () => {
    expect(decideApproval(s({ autoPublish: true }), 5)).toEqual({
      autoApprove: false,
      autoPublish: false,
    });
    expect(decideApproval(s({ autoApproveMinStars: 4, autoPublish: true }), 5)).toEqual({
      autoApprove: true,
      autoPublish: true,
    });
    expect(decideApproval(s({ autoApproveMinStars: 4 }), 5).autoPublish).toBe(false);
    expect(decideApproval(s({ autoApproveMinStars: 4, autoPublish: true }), 3)).toEqual({
      autoApprove: false,
      autoPublish: false,
    });
  });
});

describe("template rendering (R3, pure)", () => {
  it("canary: substitutes all three variables", () => {
    expect(
      renderTemplate("Hi {reviewer_first_name}, {location_name} on {phone}. {phone}", {
        reviewer_first_name: "Jane",
        location_name: "Acme Dental",
        phone: "(713) 555-0142",
      }),
    ).toBe("Hi Jane, Acme Dental on (713) 555-0142. (713) 555-0142");
  });
  it("does not re-expand substituted values", () => {
    expect(renderTemplate("{location_name}", { location_name: "A {phone} B", phone: "1" })).toBe(
      "A {phone} B",
    );
  });
  it("unknown variables fail validation", () => {
    for (const body of ["Hello {first_name}", "{ phone }", "{}", "{Phone}"]) {
      expect(() => validateTemplateBody(body)).toThrow(CoreError);
    }
    expect(() => validateTemplateBody("Plain text, a {location_name} and {phone}")).not.toThrow();
  });
  it("generic = no reviewer_first_name", () => {
    expect(isGenericTemplate("Thanks from {location_name}")).toBe(true);
    expect(isGenericTemplate("Thanks {reviewer_first_name}")).toBe(false);
  });
  it("reviewer first name: first token; anonymous variants are unavailable", () => {
    expect(reviewerFirstName("  Jane  Q Doe ", false)).toBe("Jane");
    expect(reviewerFirstName("A Google User", false)).toBeNull();
    expect(reviewerFirstName("a google user", false)).toBeNull();
    expect(reviewerFirstName("Jane", true)).toBeNull();
    expect(reviewerFirstName(null, false)).toBeNull();
    expect(reviewerFirstName("  ", false)).toBeNull();
  });
  it("missing values name the variable", () => {
    const e = (() => {
      try {
        renderTemplate("Call {phone}", { phone: null });
      } catch (x) {
        return x as TemplateRenderError;
      }
      throw new Error("no error");
    })();
    expect(e).toBeInstanceOf(TemplateRenderError);
    expect(e.variable).toBe("phone");
    expect(e.message).toContain("{phone}");
  });
});

describe("workspaceSettings actions (R4, G4)", () => {
  let org: Org;
  let other: Org;
  beforeAll(async () => {
    org = await makeOrg();
    other = await makeOrg();
  });
  const get = (actor: Actor, workspaceId: string) =>
    run(actor, "workspaceSettings.get", { workspaceId }) as Promise<Settings>;
  const update = (actor: Actor, input: Record<string, unknown>) =>
    run(actor, "workspaceSettings.update", input) as Promise<Settings>;

  it("get returns defaults for a never-configured workspace, and getWorkspaceReplySettings agrees", async () => {
    const s = await get(org.owner, org.a);
    expect(s).toEqual({ workspaceId: org.a, ...DEFAULT_WORKSPACE_REPLY_SETTINGS, autoApproveLocked: false, autoApproveEnabledBy: null, autoApproveEnabledAt: null });
    expect(await getWorkspaceReplySettings(db as never, org.a)).toEqual(
      DEFAULT_WORKSPACE_REPLY_SETTINGS,
    );
  });

  it("auto-approve is off by default, per workspace, and records who turned it on and when (Q15)", async () => {
    const o = await makeOrg();
    // Another client of the same organisation turning it on does not touch this one.
    const before = Date.now();
    const on = await update(o.admin, { workspaceId: o.a, autoApproveMinStars: 4 });
    expect(on.autoApproveMinStars).toBe(4);
    const rec = on as Settings & { autoApproveEnabledBy: { userId: string; name: string } | null; autoApproveEnabledAt: string | null };
    expect(rec.autoApproveEnabledBy?.userId).toBe(o.admin.userId);
    expect(Date.parse(rec.autoApproveEnabledAt!)).toBeGreaterThanOrEqual(before - 1000);
    const other = (await get(o.owner, o.b)) as typeof rec;
    expect(other).toMatchObject({ autoApproveMinStars: null, autoPublish: false, autoApproveEnabledBy: null, autoApproveEnabledAt: null });
    // Changing 4 to 5 keeps the original record; another field does too.
    const again = (await update(o.owner, { workspaceId: o.a, autoApproveMinStars: 5 })) as typeof rec;
    expect(again.autoApproveEnabledBy?.userId).toBe(o.admin.userId);
    expect(again.autoApproveEnabledAt).toBe(rec.autoApproveEnabledAt);
    // Off clears it; on again records the new person.
    const off = (await update(o.owner, { workspaceId: o.a, autoApproveMinStars: null })) as typeof rec;
    expect(off).toMatchObject({ autoApproveEnabledBy: null, autoApproveEnabledAt: null });
    const re = (await update(o.owner, { workspaceId: o.a, autoApproveMinStars: 5 })) as typeof rec;
    expect(re.autoApproveEnabledBy?.userId).toBe(o.owner.userId);
  });

  it("update stores fields and audits before/after", async () => {
    const out = await update(org.admin, {
      workspaceId: org.a,
      staffNames: ["Rosa Diaz", "Diaz", "Rosa Diaz"],
      autoApproveMinStars: 5,
      autoPublish: true,
    });
    expect(out).toMatchObject({
      staffNames: ["Rosa Diaz", "Diaz"],
      autoApproveMinStars: 5,
      autoPublish: true,
      profile: "general",
    });
    expect(await get(org.viewer, org.a)).toEqual(out);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.action, "workspace_settings.update")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "workspace_reply_settings", entityId: org.a });
    expect(rows[0]!.before).toMatchObject({ autoApproveMinStars: null, autoPublish: false });
    expect(rows[0]!.after).toMatchObject({
      autoApproveMinStars: 5,
      autoPublish: true,
      staffNames: ["Rosa Diaz", "Diaz"],
    });
    // The stored row reaches decideApproval through the real lookup.
    const real = await getWorkspaceReplySettings(db as never, org.a);
    expect(decideApproval(real, 5)).toEqual({ autoApprove: true, autoPublish: true });
    expect(decideApproval(real, 4)).toEqual({ autoApprove: false, autoPublish: false });
  });

  it("switching to healthcare applies defaults; an explicit skipPositiveReviews=false persists", async () => {
    const h = await update(org.owner, { workspaceId: org.b, profile: "healthcare" });
    expect(h).toMatchObject({
      profile: "healthcare",
      packs: ["hipaa"],
      skipPositiveReviews: true,
      genericTemplatesOnly: true,
    });
    const off = await update(org.owner, { workspaceId: org.b, skipPositiveReviews: false });
    expect(off).toMatchObject({ profile: "healthcare", skipPositiveReviews: false });
    // Re-sending the same profile does not reset the explicit value.
    const again = await update(org.owner, { workspaceId: org.b, profile: "healthcare" });
    expect(again.skipPositiveReviews).toBe(false);
    expect((await get(org.owner, org.b)).skipPositiveReviews).toBe(false);
  });

  it("profile and explicit fields in one call: defaults first, explicit wins", async () => {
    const out = await update(org.owner, {
      workspaceId: org.b,
      profile: "legal",
      skipPositiveReviews: true,
      packs: [],
    });
    // legal_ethics is the profile's own pack and cannot be removed
    expect(out).toMatchObject({
      profile: "legal",
      packs: ["legal_ethics"],
      skipPositiveReviews: true,
      genericTemplatesOnly: false,
    });
    const general = await update(org.owner, { workspaceId: org.b, profile: "general" });
    expect(general).toMatchObject({ profile: "general", packs: [], skipPositiveReviews: false });
  });

  it("optional packs can be added under any profile; healthcare cannot drop hipaa", async () => {
    const both = await update(org.owner, { workspaceId: org.b, packs: ["legal_ethics", "hipaa"] });
    expect(both.packs).toEqual(["hipaa", "legal_ethics"]);
    await update(org.owner, { workspaceId: org.b, profile: "healthcare", packs: [] });
    expect((await get(org.owner, org.b)).packs).toEqual(["hipaa"]);
    await update(org.owner, { workspaceId: org.b, profile: "general", packs: [] });
  });

  it("rejects invalid input", async () => {
    for (const bad of [
      { packs: ["universal"] },
      { packs: ["gdpr"] },
      { profile: "dental" },
      { autoApproveMinStars: 3 },
      { autoApproveMinStars: 6 },
      { staffNames: ["x"] },
      { staffNames: ["y".repeat(81)] },
      { staffNames: Array.from({ length: 201 }, (_, i) => `Name ${i}`) },
    ]) {
      expect(
        await codeOf(run(org.owner, "workspaceSettings.update", { workspaceId: org.a, ...bad })),
        JSON.stringify(bad).slice(0, 60),
      ).toBe("INVALID_INPUT");
    }
    const max = Array.from({ length: 200 }, (_, i) => `Name ${i}`);
    expect(
      (await update(org.owner, { workspaceId: org.a, staffNames: max })).staffNames,
    ).toHaveLength(200);
  });

  it("autoApproveMinStars accepts 4, 5 and null (off)", async () => {
    expect(
      (await update(org.owner, { workspaceId: org.a, autoApproveMinStars: 4 })).autoApproveMinStars,
    ).toBe(4);
    expect(
      (await update(org.owner, { workspaceId: org.a, autoApproveMinStars: null }))
        .autoApproveMinStars,
    ).toBeNull();
    // the table itself also refuses other values
    await expect(
      sql`update workspace_reply_settings set auto_approve_min_stars = 3 where workspace_id = ${org.a}`,
    ).rejects.toThrow();
  });

  it("h2Severity: defaults to block, update to warn is audited, invalid values are rejected, client roles cannot change it", async () => {
    const o = await makeOrg();
    expect((await get(o.owner, o.a)).h2Severity).toBe("block");
    expect(DEFAULT_WORKSPACE_REPLY_SETTINGS.h2Severity).toBe("block");

    const warn = await update(o.admin, { workspaceId: o.a, h2Severity: "warn" });
    expect(warn.h2Severity).toBe("warn");
    expect((await get(o.viewer, o.a)).h2Severity).toBe("warn");
    expect((await getWorkspaceReplySettings(db as never, o.a)).h2Severity).toBe("warn");
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, o.orgId), eq(auditLog.action, "workspace_settings.update")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before).toMatchObject({ h2Severity: "block" });
    expect(rows[0]!.after).toMatchObject({ h2Severity: "warn" });

    // unrelated updates keep it; switching profile does not reset it
    expect((await update(o.owner, { workspaceId: o.a, autoPublish: true })).h2Severity).toBe(
      "warn",
    );
    expect((await update(o.owner, { workspaceId: o.a, profile: "healthcare" })).h2Severity).toBe(
      "warn",
    );
    expect((await update(o.owner, { workspaceId: o.a, h2Severity: "block" })).h2Severity).toBe(
      "block",
    );

    for (const bad of ["off", "WARN", "", null, 1]) {
      expect(
        await codeOf(
          run(o.owner, "workspaceSettings.update", { workspaceId: o.a, h2Severity: bad }),
        ),
        String(bad),
      ).toBe("INVALID_INPUT");
    }
    // the table refuses it too
    await expect(
      sql`update workspace_reply_settings set h2_severity = 'off' where workspace_id = ${o.a}`,
    ).rejects.toThrow();

    for (const a of [o.manager, o.approver, o.viewer]) {
      expect(
        await codeOf(run(a, "workspaceSettings.update", { workspaceId: o.a, h2Severity: "warn" })),
      ).toBe("FORBIDDEN");
    }
    expect((await get(o.owner, o.a)).h2Severity).toBe("block");
  });

  it("roles: configure is owner/admin only; read is allowed for everyone in scope", async () => {
    for (const a of [org.manager, org.approver, org.viewer]) {
      expect(await codeOf(run(a, "workspaceSettings.update", { workspaceId: org.a }))).toBe(
        "FORBIDDEN",
      );
    }
    for (const a of [org.owner, org.admin, org.manager, org.approver, org.viewer]) {
      expect((await get(a, org.a)).workspaceId).toBe(org.a);
    }
    // client scope: workspace B is outside the viewer's workspaces
    expect(await codeOf(get(org.viewer, org.b))).toBe("FORBIDDEN");
  });

  it("is tenant-scoped", async () => {
    expect(await codeOf(get(other.owner, org.a))).toBe("NOT_FOUND");
    expect(await codeOf(run(other.owner, "workspaceSettings.update", { workspaceId: org.a }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("replyPolicy through reviews.list_unreplied (G4)", () => {
  let org: Org;
  beforeAll(async () => {
    org = await makeOrg();
    const la = await org.mkLoc(org.a, "Healthcare loc");
    const lb = await org.mkLoc(org.b, "General loc");
    for (const l of [la, lb]) {
      await mkReview(l, { rating: 5 });
      await mkReview(l, { rating: 4 });
      await mkReview(l, { rating: 2 });
    }
    await run(org.owner, "workspaceSettings.update", { workspaceId: org.a, profile: "healthcare" });
  });
  type Out = {
    items: {
      location: { name: string };
      rating: number;
      replyAllowed: boolean;
      skipReason: string | null;
    }[];
  };
  const unreplied = (input: Record<string, unknown> = {}) =>
    run(org.owner, "reviews.list_unreplied", input) as Promise<Out>;

  it("excludes healthcare positive reviews by default", async () => {
    const r = await unreplied();
    const hc = r.items.filter((i) => i.location.name === "Healthcare loc");
    expect(hc.map((i) => i.rating)).toEqual([2]);
    expect(r.items.filter((i) => i.location.name === "General loc")).toHaveLength(3);
  });

  it("includeSkipped shows them with replyAllowed=false and the reason", async () => {
    const r = await unreplied({ includeSkipped: true });
    const hc = r.items.filter((i) => i.location.name === "Healthcare loc");
    expect(hc).toHaveLength(3);
    const skipped = hc.filter((i) => !i.replyAllowed);
    expect(skipped.map((i) => i.rating).sort()).toEqual([4, 5]);
    expect(skipped.every((i) => i.skipReason?.startsWith("Healthcare profile"))).toBe(true);
    expect(hc.find((i) => i.rating === 2)).toMatchObject({ replyAllowed: true, skipReason: null });
  });

  it("an explicit skipPositiveReviews=false brings them back", async () => {
    await run(org.owner, "workspaceSettings.update", {
      workspaceId: org.a,
      skipPositiveReviews: false,
    });
    const r = await unreplied();
    expect(r.items.filter((i) => i.location.name === "Healthcare loc")).toHaveLength(3);
    expect(replyPolicy({ starRating: 5, comment: null }, { skipPositiveReviews: false })).toEqual({
      replyAllowed: true,
      skipReason: null,
    });
  });
});

describe("replyTemplates actions (R3)", () => {
  let org: Org;
  let other: Org;
  let loc: Awaited<ReturnType<Org["mkLoc"]>>;
  let noPhone: Awaited<ReturnType<Org["mkLoc"]>>;
  let hcLoc: Awaited<ReturnType<Org["mkLoc"]>>;
  beforeAll(async () => {
    org = await makeOrg();
    other = await makeOrg();
    loc = await org.mkLoc(org.a, "Internal name", {
      title: "Acme Dental",
      phone: "(713) 555-0142",
    });
    noPhone = await org.mkLoc(org.a, "No phone loc");
    hcLoc = await org.mkLoc(org.b, "HC", { title: "HC Clinic", phone: "(713) 555-0199" });
    await run(org.owner, "workspaceSettings.update", { workspaceId: org.b, profile: "healthcare" });
  });
  const create = (actor: Actor, input: Record<string, unknown>) =>
    run(actor, "replyTemplates.create", input) as Promise<{ template: Template }>;
  const render = (actor: Actor, templateId: string, reviewId: string) =>
    run(actor, "replyTemplates.render", { templateId, reviewId }) as Promise<{ body: string }>;

  it("CRUD with audit rows; generic is computed", async () => {
    const t = (
      await create(org.owner, {
        workspaceId: org.a,
        name: "Thanks",
        body: "Hi {reviewer_first_name}, thanks from {location_name}.",
      })
    ).template;
    expect(t.generic).toBe(false);
    const upd = (
      (await run(org.admin, "replyTemplates.update", {
        id: t.id,
        body: "Thanks from {location_name}. Call {phone}.",
      })) as { template: Template }
    ).template;
    expect(upd).toMatchObject({ generic: true, name: "Thanks" });
    const renamed = (
      (await run(org.owner, "replyTemplates.update", { id: t.id, name: "Thanks v2" })) as {
        template: Template;
      }
    ).template;
    expect(renamed.name).toBe("Thanks v2");
    const list = (await run(org.viewer, "replyTemplates.list", { workspaceId: org.a })) as {
      templates: Template[];
    };
    expect(list.templates.map((x) => x.name)).toEqual(["Thanks v2"]);
    await run(org.owner, "replyTemplates.delete", { id: t.id });
    expect(
      (
        (await run(org.owner, "replyTemplates.list", { workspaceId: org.a })) as {
          templates: Template[];
        }
      ).templates,
    ).toHaveLength(0);
    const actionsSeen = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.orgId, org.orgId))
    ).map((r) => r.action);
    for (const a of ["reply_template.create", "reply_template.update", "reply_template.delete"]) {
      expect(actionsSeen).toContain(a);
    }
  });

  it("names are unique per workspace; unknown variables and bad input are rejected", async () => {
    await create(org.owner, { workspaceId: org.a, name: "Dup", body: "ok" });
    expect(await codeOf(create(org.owner, { workspaceId: org.a, name: "Dup", body: "x" }))).toBe(
      "CONFLICT",
    );
    // same name in another workspace is fine
    await create(org.owner, { workspaceId: org.b, name: "Dup", body: "ok" });
    const other2 = (await create(org.owner, { workspaceId: org.a, name: "Dup2", body: "ok" }))
      .template;
    expect(
      await codeOf(run(org.owner, "replyTemplates.update", { id: other2.id, name: "Dup" })),
    ).toBe("CONFLICT");
    const e = await errOf(
      create(org.owner, { workspaceId: org.a, name: "Bad", body: "Hello {first_name}" }),
    );
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("{first_name}");
    expect(
      await codeOf(run(org.owner, "replyTemplates.update", { id: other2.id, body: "x {nope}" })),
    ).toBe("INVALID_INPUT");
    expect(await codeOf(create(org.owner, { workspaceId: org.a, name: "", body: "x" }))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(create(org.owner, { workspaceId: org.a, name: "E", body: " " }))).toBe(
      "INVALID_INPUT",
    );
  });

  it("client roles and managers cannot configure; clients can list their workspace only", async () => {
    for (const a of [org.manager, org.approver, org.viewer]) {
      expect(await codeOf(create(a, { workspaceId: org.a, name: "X", body: "x" }))).toBe(
        "FORBIDDEN",
      );
    }
    const t = (await create(org.owner, { workspaceId: org.a, name: "Guarded", body: "x" }))
      .template;
    for (const a of [org.manager, org.approver, org.viewer]) {
      expect(await codeOf(run(a, "replyTemplates.update", { id: t.id, name: "Y" }))).toBe(
        "FORBIDDEN",
      );
      expect(await codeOf(run(a, "replyTemplates.delete", { id: t.id }))).toBe("FORBIDDEN");
    }
    for (const a of [org.approver, org.viewer, org.manager]) {
      expect(
        ((await run(a, "replyTemplates.list", { workspaceId: org.a })) as { templates: unknown[] })
          .templates.length,
      ).toBeGreaterThan(0);
    }
    expect(await codeOf(run(org.viewer, "replyTemplates.list", { workspaceId: org.b }))).toBe(
      "FORBIDDEN",
    );
  });

  it("is tenant-scoped", async () => {
    const t = (await create(org.owner, { workspaceId: org.a, name: "Tenant", body: "x" })).template;
    expect(await codeOf(run(other.owner, "replyTemplates.delete", { id: t.id }))).toBe("NOT_FOUND");
    expect(await codeOf(create(other.owner, { workspaceId: org.a, name: "Z", body: "x" }))).toBe(
      "NOT_FOUND",
    );
    expect(
      (
        (await run(other.owner, "replyTemplates.list", { workspaceId: org.a })) as {
          templates: unknown[];
        }
      ).templates,
    ).toHaveLength(0);
  });

  it("render substitutes reviewer first name, location title and phone", async () => {
    const t = (
      await create(org.owner, {
        workspaceId: org.a,
        name: "Full",
        body: "Hi {reviewer_first_name}! {location_name}: {phone}",
      })
    ).template;
    const r = await mkReview(loc, { name: "Jane Q Doe" });
    expect(await render(org.manager, t.id, r.id)).toEqual({
      body: "Hi Jane! Acme Dental: (713) 555-0142",
    });
    // writes nothing: no audit row for render
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.orgId, org.orgId), eq(auditLog.entityId, t.id)));
    expect(rows.map((x) => x.action)).toEqual(["reply_template.create"]);
  });

  it("render errors: anonymous reviewer, missing phone", async () => {
    const named = (
      await create(org.owner, {
        workspaceId: org.a,
        name: "Named",
        body: "Hi {reviewer_first_name}",
      })
    ).template;
    for (const rv of [
      await mkReview(loc, { name: "A Google User" }),
      await mkReview(loc, { name: "Someone", anonymous: true }),
      await mkReview(loc, { name: null }),
    ]) {
      const e = await errOf(render(org.owner, named.id, rv.id));
      expect(e).toBeInstanceOf(TemplateRenderError);
      expect(e.message).toBe("reviewer name unavailable");
    }
    const phoneT = (
      await create(org.owner, { workspaceId: org.a, name: "Phone", body: "Call {phone}" })
    ).template;
    const e = await errOf(render(org.owner, phoneT.id, (await mkReview(noPhone)).id));
    expect(e).toMatchObject({ code: "INVALID_INPUT", variable: "phone" });
  });

  it("render needs review:draft and a visible review in the template's workspace", async () => {
    const t = (await create(org.owner, { workspaceId: org.a, name: "Perm", body: "{phone}" }))
      .template;
    const r = await mkReview(loc);
    for (const a of [org.viewer, org.approver]) {
      expect(await codeOf(render(a, t.id, r.id))).toBe("FORBIDDEN");
    }
    const inB = await mkReview(hcLoc);
    expect(await codeOf(render(org.owner, t.id, inB.id))).toBe("INVALID_INPUT");
    expect(await codeOf(render(other.owner, t.id, r.id))).toBe("NOT_FOUND");
    expect(await codeOf(render(org.owner, t.id, "00000000-0000-4000-8000-000000000000"))).toBe(
      "NOT_FOUND",
    );
  });

  it("genericTemplatesOnly blocks non-generic templates, allows generic ones", async () => {
    const generic = (
      await create(org.owner, { workspaceId: org.b, name: "Gen", body: "Thanks, {location_name}" })
    ).template;
    const specific = (
      await create(org.owner, {
        workspaceId: org.b,
        name: "Spec",
        body: "Hi {reviewer_first_name}",
      })
    ).template;
    const r = await mkReview(hcLoc, { rating: 2 });
    expect(await render(org.owner, generic.id, r.id)).toEqual({ body: "Thanks, HC Clinic" });
    const e = await errOf(render(org.owner, specific.id, r.id));
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toBe("Healthcare profile allows generic templates only");
  });
});
