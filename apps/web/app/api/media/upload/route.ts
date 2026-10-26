import type { NextRequest } from "next/server";
import { handleMediaUploadRequest } from "@opengmb/core";
import { getAuth, getDb, refuseWhileViewing } from "../../../../lib/auth";

/**
 * Photo upload from the browser (multipart/form-data: locationId, category, file). Session, MFA,
 * authorization and validation are all core's (handleMediaUploadRequest); this only supplies the
 * session and the database. The file is never written to disk or served back.
 */
export async function POST(request: NextRequest) {
  const viewing = await refuseWhileViewing();
  if (viewing) return viewing;
  return handleMediaUploadRequest(request, {
    db: getDb(),
    getSession: () => getAuth().api.getSession({ headers: request.headers }),
  });
}
