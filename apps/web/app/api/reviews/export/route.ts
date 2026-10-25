import { NextResponse, type NextRequest } from "next/server";
import { exportInputFromParams } from "../../../../lib/review-filters";
import { getTimeFormat } from "../../../../lib/time-format-server";
import { runAction } from "../../../../lib/run-action";

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
};

/**
 * Logged-in CSV download of the reviews matching the page's filters. Core authorizes (review:read +
 * workspace scope) and audits the export (filters and row count, never review text).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const result = await runAction(
    "reviews.export",
    exportInputFromParams(params, await getTimeFormat(params.get("ws") ?? undefined)),
  );
  if (!result.ok) {
    return new NextResponse(result.error.message, { status: STATUS[result.error.code] ?? 500 });
  }
  const { csv, filename } = result.data as { csv: string; filename: string };
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
