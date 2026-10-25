import { NextResponse, type NextRequest } from "next/server";
import { isLikelyBot, parseSource, resolveReviewLink } from "@opengmb/core";
import { getDb } from "../../../lib/auth";

// Public, no login, never cached: every open is counted.
export const dynamic = "force-dynamic";
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

async function target(request: NextRequest, params: Promise<{ slug: string }>, count: boolean) {
  const { slug } = await params;
  return resolveReviewLink(getDb(), slug, {
    source: parseSource(request.nextUrl.searchParams.get("s")),
    count: count && !isLikelyBot(request.headers.get("user-agent")),
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const to = await target(request, params, true);
  if (!to) return new NextResponse("This review link does not exist.", { status: 404, headers: HEADERS });
  return NextResponse.redirect(to, { status: 302, headers: HEADERS });
}

/** A HEAD request (link checkers) gets the same answer and is never counted. */
export async function HEAD(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const to = await target(request, params, false);
  if (!to) return new NextResponse(null, { status: 404, headers: HEADERS });
  return NextResponse.redirect(to, { status: 302, headers: HEADERS });
}
