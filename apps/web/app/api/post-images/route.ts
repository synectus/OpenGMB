import type { NextRequest } from "next/server";
import { handlePostImageUpload } from "@opengmb/core";
import { getAuth, getDb } from "../../../lib/auth";

/** Library upload from the browser (multipart: workspaceId, file). All checks are core's. */
export async function POST(request: NextRequest) {
  return handlePostImageUpload(request, {
    db: getDb(),
    getSession: () => getAuth().api.getSession({ headers: request.headers }),
  });
}
