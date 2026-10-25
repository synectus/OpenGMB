import type { NextRequest } from "next/server";
import { handleFileGet } from "@opengmb/core";
import { getAuth, getDb } from "../../../../lib/auth";

/** A stored file (a logo) for a signed-in member of its organization. Tenant checks are core's. */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handleFileGet(id, {
    db: getDb(),
    getSession: () => getAuth().api.getSession({ headers: request.headers }),
  });
}
