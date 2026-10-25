import { eq } from "drizzle-orm";
import { z } from "zod";
import { orgDataforseoCredentials, type Tx } from "@opengmb/db";
import type { Actor } from "../actor";
import { encryptSecret } from "../crypto";
import { CoreError } from "../errors";
import { loadByoCredentials, maskLogin, usageByMonth } from "../geogrid/byo";
import { createLiveDriverRegistry } from "../geogrid/drivers";
import { defineAction } from "../registry";

/** Credential checks: a free DataForSEO user_data call when the server has a live rank source, else the offline fixture. */
const drivers = createLiveDriverRegistry();

// Same org-level gate as the geo-grid billing settings: owner and admin (google:manage).
const PERMISSION = "google:manage" as const;

const keyOut = z.object({
  configured: z.boolean(),
  /** Masked (first two characters + domain). The password is never returned by any action. */
  login: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
});

async function readKey(tx: Tx, actor: Actor): Promise<z.input<typeof keyOut>> {
  const [row] = await tx
    .select()
    .from(orgDataforseoCredentials)
    .where(eq(orgDataforseoCredentials.orgId, actor.orgId));
  return {
    configured: !!row,
    login: row ? maskLogin(row.login) : null,
    lastVerifiedAt: row?.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
  };
}

export const geogridByoKeyGet = defineAction({
  name: "geogrid.byoKey.get",
  description:
    "Whether this organization has its own DataForSEO API key (bring your own key) and the masked login. Never returns the password. With a key, geo-grid Maps-rank runs use it, are billed at cost with no markup, and do not count against the monthly resold-spend budget. Needs google:manage (owner, admin).",
  input: z.object({}),
  output: keyOut,
  permission: PERMISSION,
  kind: "read",
  async handler({ tx, actor }) {
    return readKey(tx, actor);
  },
});

export const geogridByoKeySet = defineAction({
  name: "geogrid.byoKey.set",
  description:
    "Store (or replace) the organization's DataForSEO API login and API password (from the API Access page of the DataForSEO dashboard; not the account password). The password is encrypted at rest and never returned or audited. Replacing the key clears the last-verified time; call geogrid.byoKey.verify afterwards. Needs google:manage (owner, admin).",
  input: z.object({
    login: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(500),
  }),
  output: keyOut,
  permission: PERMISSION,
  kind: "write",
  // Not two_phase on purpose: a proposal stores its input, and this input is the API password.
  approval: "own_flow",
  async preview() {
    // Never echo the input: it carries the password (the generic preview would).
    return { summary: "Store this organization's DataForSEO API key (login and password are not shown)" };
  },
  async handler({ tx, actor, audit }, input) {
    const before = await readKey(tx, actor);
    const passwordEnc = encryptSecret(input.password);
    await tx
      .insert(orgDataforseoCredentials)
      .values({
        orgId: actor.orgId,
        login: input.login,
        passwordEnc,
        createdBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: orgDataforseoCredentials.orgId,
        set: {
          login: input.login,
          passwordEnc,
          updatedAt: new Date(),
          lastVerifiedAt: null,
        },
      });
    const after = await readKey(tx, actor);
    await audit({
      action: "geogrid.byo_key_set",
      entityType: "org_dataforseo_credentials",
      entityId: actor.orgId,
      before: { configured: before.configured, login: before.login },
      after: { configured: true, login: after.login },
    });
    return after;
  },
});

export const geogridByoKeyDelete = defineAction({
  name: "geogrid.byoKey.delete",
  description:
    "Remove the organization's DataForSEO key. Later runs go back to our key with the markup and the monthly budget. Runs already requested with the customer key fail instead of using ours. Needs google:manage (owner, admin).",
  input: z.object({}),
  output: keyOut,
  permission: PERMISSION,
  kind: "write",
  async handler({ tx, actor, audit }) {
    const before = await readKey(tx, actor);
    if (!before.configured) throw new CoreError("NOT_FOUND", "No DataForSEO key is configured");
    await tx
      .delete(orgDataforseoCredentials)
      .where(eq(orgDataforseoCredentials.orgId, actor.orgId));
    await audit({
      action: "geogrid.byo_key_deleted",
      entityType: "org_dataforseo_credentials",
      entityId: actor.orgId,
      before: { configured: true, login: before.login },
      after: { configured: false },
    });
    return readKey(tx, actor);
  },
});

export const geogridByoKeyVerify = defineAction({
  name: "geogrid.byoKey.verify",
  description:
    "Check the stored DataForSEO key with the driver's credential check (a free DataForSEO user_data call when the server has a live rank source, otherwise an offline fixture). Returns ok or failed with a message and records the last-verified time on success. Needs google:manage (owner, admin).",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string(), lastVerifiedAt: z.string().nullable() }),
  permission: PERMISSION,
  kind: "write",
  async handler({ tx, actor, audit }) {
    const creds = await loadByoCredentials(tx, actor.orgId);
    if (!creds) throw new CoreError("NOT_FOUND", "No DataForSEO key is configured");
    const check = await drivers.checkDataForSeoCredentials(creds);
    const now = new Date();
    if (check.ok) {
      await tx
        .update(orgDataforseoCredentials)
        .set({ lastVerifiedAt: now })
        .where(eq(orgDataforseoCredentials.orgId, actor.orgId));
    }
    await audit({
      action: "geogrid.byo_key_verified",
      entityType: "org_dataforseo_credentials",
      entityId: actor.orgId,
      before: null,
      after: { ok: check.ok, message: check.message },
    });
    return {
      ok: check.ok,
      message: check.message,
      lastVerifiedAt: (await readKey(tx, actor)).lastVerifiedAt,
    };
  },
});

const bucket = z.object({
  runs: z.number(),
  points: z.number(),
  tasks: z.number(),
  costAtDataforseoUsd: z.number(),
  chargedUsd: z.number(),
});
const MAX_SPAN_DAYS = 800;

export const geogridUsage = defineAction({
  name: "geogrid.usage",
  description:
    "Geo-grid usage and cost per UTC month for runs created from `from` to `to` (inclusive dates, YYYY-MM-DD, at most about 26 months). Per month: runs, points (tasks submitted), tasks (finished, billable), cost_at_dataforseo (tasks x DataForSEO's per-task price), charged (what we charged: BYO runs at cost with no markup, resold runs with the markup), split into byo and resold. BYO runs are not part of the monthly budget. Needs geogrid:cost (owner, admin, manager; hidden from client roles).",
  input: z.object({ from: z.iso.date(), to: z.iso.date() }),
  output: z.object({
    months: z.array(z.object({ month: z.string(), byo: bucket, resold: bucket, total: bucket })),
  }),
  permission: "geogrid:cost",
  kind: "read",
  async handler({ tx, actor }, input) {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(new Date(`${input.to}T00:00:00.000Z`).getTime() + 86_400_000);
    if (to <= from) throw new CoreError("INVALID_INPUT", "`to` must not be before `from`");
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_SPAN_DAYS) {
      throw new CoreError("INVALID_INPUT", `Range is limited to ${MAX_SPAN_DAYS} days`);
    }
    return { months: await usageByMonth(tx, actor.orgId, from, to) };
  },
});
