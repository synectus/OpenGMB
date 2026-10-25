import { NextResponse } from "next/server";
import { openSharedReport } from "@opengmb/core";
import { getDb } from "../../../../lib/auth";

// Public: no login. Access is decided by core (valid, unexpired, unrevoked token) and audited there
// (reports.share_accessed / reports.share_denied). The landing page is ../page.tsx.
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await openSharedReport(getDb(), token);
  const headers = {
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex",
    "referrer-policy": "no-referrer",
  };
  if (res.status === "invalid") return new NextResponse("Not found", { status: 404, headers });
  if (res.status !== "ok") {
    return new NextResponse("This link has expired or was revoked", { status: 410, headers });
  }
  return new NextResponse(new Uint8Array(res.pdf), {
    headers: {
      ...headers,
      "content-type": "application/pdf",
      "content-length": String(res.pdf.length),
      "content-disposition": `attachment; filename="${res.filename}"`,
    },
  });
}
