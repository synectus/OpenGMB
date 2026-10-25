import { NextResponse, type NextRequest } from "next/server";
import { counterCardPdf, qrPng, qrSvg } from "@opengmb/core";
import { runAction } from "../../../../../lib/run-action";
import { trackedUrl } from "../../../../../lib/review-requests";

export const runtime = "nodejs";
const STATUS: Record<string, number> = { UNAUTHENTICATED: 401, MFA_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404, INVALID_INPUT: 400 };

/** Logged-in QR download: ?format=svg (default, shown on the page), png or pdf (the counter card). Core authorises through reviewLinks.get. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params;
  const got = await runAction("reviewLinks.get", { locationId });
  if (!got.ok) return new NextResponse(got.error.message, { status: STATUS[got.error.code] ?? 500 });
  const d = got.data as { location: { name: string }; link: { slug: string } | null };
  if (!d.link) return new NextResponse("No tracked link for this location yet.", { status: 404 });
  const url = trackedUrl(process.env.BETTER_AUTH_URL || request.nextUrl.origin, d.link.slug, "qr");
  const format = request.nextUrl.searchParams.get("format");
  const base = { "cache-control": "private, no-store" };
  if (format === "png") {
    return new NextResponse(new Uint8Array(await qrPng(url)), { headers: { ...base, "content-type": "image/png", "content-disposition": `attachment; filename="${d.link.slug}-qr.png"` } });
  }
  if (format === "pdf") {
    const brand = await runAction("branding.get", {});
    const agencyName = brand.ok ? ((brand.data as { agencyName?: string }).agencyName ?? null) : null;
    const pdf = await counterCardPdf({ locationName: d.location.name, agencyName, url });
    return new NextResponse(new Uint8Array(pdf), { headers: { ...base, "content-type": "application/pdf", "content-disposition": `attachment; filename="${d.link.slug}-counter-card.pdf"` } });
  }
  return new NextResponse(qrSvg(url, `QR code for the ${d.location.name} review link`), { headers: { ...base, "content-type": "image/svg+xml" } });
}
