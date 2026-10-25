import type { NextRequest } from "next/server";
import { handleBrandedPreview } from "@opengmb/core";
import { getAuth, getDb } from "../../../../lib/auth";

/** Branded image preview from the browser (JSON body). Returns the image, stores nothing. All checks are core's. */
export async function POST(request: NextRequest) {
  return handleBrandedPreview(request, {
    db: getDb(),
    getSession: () => getAuth().api.getSession({ headers: request.headers }),
  });
}
