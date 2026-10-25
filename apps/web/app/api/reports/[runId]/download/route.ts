import { NextResponse, type NextRequest } from "next/server";
import {
  AuthError,
  CoreError,
  loadActor,
  loadReportPdf,
  requireAuthenticatedUser,
} from "@opengmb/core";
import { getAuth, getDb } from "../../../../../lib/auth";

/** Logged-in download. core authorizes (report:read + workspace scope) before any bytes are read. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  try {
    const session = await getAuth().api.getSession({ headers: request.headers });
    const { userId } = requireAuthenticatedUser(session);
    const db = getDb();
    const actor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
    const { pdf, filename } = await loadReportPdf(db, actor, runId);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.length),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return new NextResponse("Unauthorized", { status: 401 });
    if (e instanceof CoreError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" ? 403 : 409;
      return new NextResponse(e.message, { status });
    }
    console.error("[web] report download failed", e);
    return new NextResponse("Internal error", { status: 500 });
  }
}
