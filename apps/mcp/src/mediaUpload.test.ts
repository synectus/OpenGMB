import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LOCATION_OP_QUEUE,
  MEDIA_LIMITS,
  createApiToken,
  ensureQueues,
  executeAction,
  loadActor,
  seedMockGoogleConnection,
} from "@opengmb/core";
import {
  createDb,
  locationWriteOps,
  locations,
  memberships,
  mediaUploads,
  organizations,
  users,
  workspaces,
} from "@opengmb/db";
import { startServer } from "./http";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set");
const { db, sql } = createDb(url);
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  process.env.GOOGLE_BUSINESS_API_MODE = "mock";
  // A fresh DB (CI) has no queues until some worker or test creates them; this file must not rely
  // on another file having run first.
  await ensureQueues(url, [LOCATION_OP_QUEUE]);
  server = await startServer(0, { db });
});
afterAll(async () => {
  await server.close();
  await sql.end();
});

/** A PNG header padded with zeros to `size` bytes (the parser reads only the header). */
function png(w: number, h: number, size: number): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
  ]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("media_upload through the real MCP HTTP transport", () => {
  it("a photo at the 5 MB cap (about 7M base64 characters in the JSON-RPC body) is proposed and applied", async () => {
    const id = `u-${uniq()}`;
    const email = `${id}@example.test`;
    const [org] = await db
      .insert(organizations)
      .values({ name: `org-${uniq()}` })
      .returning();
    const [ws] = await db.insert(workspaces).values({ orgId: org!.id, name: "A" }).returning();
    await db.insert(users).values({ id, name: "T", email, twoFactorEnabled: true });
    await db.insert(memberships).values({ orgId: org!.id, userId: id, role: "owner" });
    const { connectionId } = await seedMockGoogleConnection(db, email);
    const [loc] = await db
      .insert(locations)
      .values({
        orgId: org!.id,
        workspaceId: ws!.id,
        name: "Clinic",
        googleAccountName: "accounts/100000000000000000001",
        googleLocationId: `locations/9${uniq().replace(/\D/g, "").slice(-12)}`,
        connectionId,
      })
      .returning();

    const bytes = png(2000, 1500, MEDIA_LIMITS.photo.maxBytes);
    const contentBase64 = bytes.toString("base64");
    expect(contentBase64.length).toBeGreaterThan(6_900_000);
    expect(contentBase64.length).toBeLessThanOrEqual(MEDIA_LIMITS.upload.maxBase64Chars);

    const { token } = await createApiToken(db, { email, name: "upload", mode: "full_autonomy" });
    const client = new Client({ name: "upload", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const proposed = await client.callTool({
        name: "media_upload",
        arguments: {
          locationId: loc!.id,
          category: "EXTERIOR",
          filename: "big.png",
          contentBase64,
        },
      });
      expect(proposed.isError).toBeFalsy();
      const p = proposed.structuredContent as { proposalId: string; preview: { summary: string } };
      expect(p.preview.summary).toContain("2000x1500");
      // Q33d: a photo goes to Google, so the token cannot apply it; the owner does in the app.
      const refused = await client.callTool({
        name: "mcp_proposals_apply",
        arguments: { proposalId: p.proposalId },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toMatch(/A person must approve this in OpenGMB/);
      const web = await loadActor(db, { userId: id, surface: "ui", actorType: "user" });
      const result = (
        (await executeAction(db, web, "mcp.proposals.apply", { proposalId: p.proposalId })) as {
          result: { operation: { id: string }; uploadId: string };
        }
      ).result;
      const [op] = await db
        .select()
        .from(locationWriteOps)
        .where(eq(locationWriteOps.id, result.operation.id));
      expect(op!.status).toBe("pending");
      const [up] = await db.select().from(mediaUploads).where(eq(mediaUploads.id, result.uploadId));
      expect(up!.byteSize).toBe(bytes.length);
      expect(Buffer.compare(up!.bytes!, bytes)).toBe(0);
    } finally {
      await client.close();
      await db.update(locations).set({ status: "inactive" }).where(eq(locations.id, loc!.id));
    }
  });
});
