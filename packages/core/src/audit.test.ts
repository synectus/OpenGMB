import { afterAll, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { auditCheckpoints, auditLog, createDb, organizations, type Tx } from "@opengmb/db";
import {
  backfillAuditCheckpoint,
  getAuditCheckpoint,
  verifyAuditChain,
  writeAudit,
  type AuditEntry,
} from "./audit";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql: client } = createDb(url);
afterAll(() => client.end());

async function newOrg() {
  const [org] = await db.insert(organizations).values({ name: "test org" }).returning();
  return org!.id;
}

const entry = (orgId: string, n: number): AuditEntry => ({
  orgId,
  actorUserId: null,
  actorType: "system",
  surface: "worker",
  action: "test.write",
  entityType: "thing",
  entityId: String(n),
  before: n === 0 ? null : { n: n - 1, nested: { b: 1, a: [1, 2] } },
  after: { n, nested: { b: 1, a: [1, 2] } },
});

async function write(orgId: string, n: number) {
  return db.transaction((tx) => writeAudit(tx, entry(orgId, n)));
}

describe("audit_log", () => {
  it("chains rows and verifies", async () => {
    const orgId = await newOrg();
    for (let i = 0; i < 3; i++) await write(orgId, i);
    expect(await verifyAuditChain(db, orgId)).toEqual({
      ok: true,
      checked: 3,
      breaks: [],
      checkpoint: "ok",
    });
  });

  it("verifies an empty chain as checked=0", async () => {
    expect(await verifyAuditChain(db, await newOrg())).toEqual({
      ok: true,
      checked: 0,
      breaks: [],
      checkpoint: "ok",
    });
  });

  it("rejects UPDATE, DELETE and TRUNCATE", async () => {
    const orgId = await newOrg();
    await write(orgId, 0);
    await expect(
      db.execute(sql`update audit_log set action = 'x' where org_id = ${orgId}`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
    await expect(
      db.execute(sql`delete from audit_log where org_id = ${orgId}`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/append-only/) } });
    await expect(db.execute(sql`truncate audit_log`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/append-only/) },
    });
    expect((await verifyAuditChain(db, orgId)).checked).toBe(1);
  });

  it("detects tampering with a stored row", async () => {
    const orgId = await newOrg();
    const rows: Awaited<ReturnType<typeof write>>[] = [];
    for (let i = 0; i < 3; i++) rows.push(await write(orgId, i));
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table audit_log disable trigger audit_log_no_update_delete`);
      await tx.execute(
        sql`update audit_log set after = '{"n": 999}'::jsonb where id = ${rows[1]!.id}`,
      );
      await tx.execute(sql`alter table audit_log enable trigger audit_log_no_update_delete`);
    });
    const v = await verifyAuditChain(db, orgId);
    expect(v).toMatchObject({ ok: false, checked: 3, brokenAt: rows[1]!.id, checkpoint: "ok" });
    expect(v.breaks).toEqual([
      { id: rows[1]!.id, kind: "hash_mismatch", detail: expect.any(String) },
    ]);
  });

  it("keeps the chain linear under 10 concurrent writers; checkpoint equals the head", async () => {
    const orgId = await newOrg();
    await Promise.all(Array.from({ length: 10 }, (_, i) => write(orgId, i)));
    expect(await verifyAuditChain(db, orgId)).toEqual({
      ok: true,
      checked: 10,
      breaks: [],
      checkpoint: "ok",
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`org_id = ${orgId}`);
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(10);
    const head = await headOf(orgId);
    const cp = await getAuditCheckpoint(db, orgId);
    expect(cp).toMatchObject({ lastId: head.id, lastHash: head.hash, rowCount: 10 });
  });
});

async function headOf(orgId: string) {
  const [head] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return head!;
}

/** Run raw maintenance SQL against audit_log with its append-only trigger disabled. */
async function withTriggerOff(run: (tx: Tx) => Promise<unknown>) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`alter table audit_log disable trigger audit_log_no_update_delete`);
    await run(tx);
    await tx.execute(sql`alter table audit_log enable trigger audit_log_no_update_delete`);
  });
}

describe("audit checkpoint", () => {
  it("deleting the newest row (trigger disabled) is a checkpoint_mismatch", async () => {
    const orgId = await newOrg();
    for (let i = 0; i < 4; i++) await write(orgId, i);
    const head = await headOf(orgId);
    await withTriggerOff((tx) => tx.execute(sql`delete from audit_log where id = ${head.id}`));
    const v = await verifyAuditChain(db, orgId);
    expect(v).toMatchObject({ ok: false, checked: 3, checkpoint: "mismatch" });
    expect(v.breaks.map((b) => b.kind)).toEqual(["checkpoint_mismatch"]);
  });

  it("truncating every row is a checkpoint_mismatch", async () => {
    const orgId = await newOrg();
    await write(orgId, 0);
    await withTriggerOff((tx) => tx.execute(sql`delete from audit_log where org_id = ${orgId}`));
    expect(await verifyAuditChain(db, orgId)).toMatchObject({
      ok: false,
      checked: 0,
      checkpoint: "mismatch",
    });
  });

  it("deleting a middle row is a prev_link break", async () => {
    const orgId = await newOrg();
    const rows: Awaited<ReturnType<typeof write>>[] = [];
    for (let i = 0; i < 3; i++) rows.push(await write(orgId, i));
    await withTriggerOff((tx) => tx.execute(sql`delete from audit_log where id = ${rows[1]!.id}`));
    const v = await verifyAuditChain(db, orgId);
    expect(v.ok).toBe(false);
    expect(v.breaks.map((b) => [b.kind, b.id])).toContainEqual(["prev_link", rows[2]!.id]);
    expect(v.checkpoint).toBe("mismatch");
  });

  it("a tampered checkpoint is invalid_signature and later writes do not re-sign it", async () => {
    const orgId = await newOrg();
    for (let i = 0; i < 2; i++) await write(orgId, i);
    await db
      .update(auditCheckpoints)
      .set({ rowCount: 99 })
      .where(eq(auditCheckpoints.orgId, orgId));
    expect(await verifyAuditChain(db, orgId)).toMatchObject({
      ok: false,
      checkpoint: "invalid_signature",
      breaks: [{ kind: "checkpoint_signature" }],
    });
    await write(orgId, 2);
    expect((await verifyAuditChain(db, orgId)).checkpoint).toBe("invalid_signature");
    await db
      .update(auditCheckpoints)
      .set({ signature: "0".repeat(64) })
      .where(eq(auditCheckpoints.orgId, orgId));
    expect((await verifyAuditChain(db, orgId)).checkpoint).toBe("invalid_signature");
  });

  it("org with rows but no checkpoint is 'missing'; backfill makes it ok and is idempotent", async () => {
    const orgId = await newOrg();
    for (let i = 0; i < 3; i++) await write(orgId, i);
    await db.delete(auditCheckpoints).where(eq(auditCheckpoints.orgId, orgId));
    // a write while the checkpoint is missing must not invent one
    await write(orgId, 3);
    expect(await getAuditCheckpoint(db, orgId)).toBeNull();
    const before = await verifyAuditChain(db, orgId);
    expect(before).toMatchObject({ ok: false, checked: 4, checkpoint: "missing" });
    expect(before.breaks.map((b) => b.kind)).toEqual(["checkpoint_missing"]);

    expect(await backfillAuditCheckpoint(db, orgId)).toEqual({ kind: "written", rowCount: 5 });
    expect(await verifyAuditChain(db, orgId)).toEqual({
      ok: true,
      checked: 5,
      breaks: [],
      checkpoint: "ok",
    });
    const head = await headOf(orgId);
    expect(head).toMatchObject({ action: "audit.checkpoint_backfill", surface: "cli" });
    expect(await getAuditCheckpoint(db, orgId)).toMatchObject({ lastId: head.id, rowCount: 5 });
    expect(await backfillAuditCheckpoint(db, orgId)).toEqual({ kind: "skipped_has_checkpoint" });
  });

  it("backfill refuses a broken chain and writes nothing", async () => {
    const orgId = await newOrg();
    const rows: Awaited<ReturnType<typeof write>>[] = [];
    for (let i = 0; i < 3; i++) rows.push(await write(orgId, i));
    await db.delete(auditCheckpoints).where(eq(auditCheckpoints.orgId, orgId));
    await withTriggerOff((tx) =>
      tx.execute(sql`update audit_log set after = '{"n":9}'::jsonb where id = ${rows[0]!.id}`),
    );
    const r = await backfillAuditCheckpoint(db, orgId);
    expect(r).toMatchObject({ kind: "refused_chain_broken", breaks: [{ kind: "hash_mismatch" }] });
    expect(await getAuditCheckpoint(db, orgId)).toBeNull();
    expect((await headOf(orgId)).id).toBe(rows[2]!.id);
  });

  it("backfill skips an org with no audit rows", async () => {
    expect(await backfillAuditCheckpoint(db, await newOrg())).toEqual({ kind: "skipped_no_rows" });
  });

  it("writeAudit throws when AUDIT_CHECKPOINT_KEY is missing or short", async () => {
    const orgId = await newOrg();
    const saved = process.env.AUDIT_CHECKPOINT_KEY;
    try {
      delete process.env.AUDIT_CHECKPOINT_KEY;
      await expect(write(orgId, 0)).rejects.toThrow(/AUDIT_CHECKPOINT_KEY is not set/);
      process.env.AUDIT_CHECKPOINT_KEY = Buffer.alloc(16, 1).toString("base64");
      await expect(write(orgId, 0)).rejects.toThrow(/at least 32 bytes/);
    } finally {
      process.env.AUDIT_CHECKPOINT_KEY = saved;
    }
    const n = await db.select().from(auditLog).where(eq(auditLog.orgId, orgId));
    expect(n).toHaveLength(0);
  });
});
