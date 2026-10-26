import type { NextRequest } from "next/server";
import { handleBrandedPreview } from "@opengmb/core";
import { getAuth, getDb, refuseWhileViewing } from "../../../../lib/auth";

/** Branded image preview from the browser (JSON body). Returns the image, stores nothing. All checks are core's. */
export async function POST(request: NextRequest) {
  const viewing = await refuseWhileViewing();
  if (viewing) return viewing;
  return handleBrandedPreview(request, {
    db: getDb(),
    getSession: () => getAuth().api.getSession({ headers: request.headers }),
  });
}
