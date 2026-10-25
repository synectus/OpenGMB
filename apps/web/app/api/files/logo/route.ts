import type { NextRequest } from "next/server";
import { handleLogoUpload } from "@opengmb/core";
import { getAuth, getDb } from "../../../../lib/auth";

/** Logo upload from Settings, Branding (multipart: file, optional workspaceId). All checks are core's. */
export async function POST(request: NextRequest) {
  return handleLogoUpload(request, {
    db: getDb(),
    getSession: () => getAuth().api.getSession({ headers: request.headers }),
  });
}
