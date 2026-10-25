import { NextResponse, type NextRequest } from "next/server";
import { workspaces_export_data } from "../../../_generated/actions";

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  CONFLICT: 409,
};

/**
 * Logged-in JSON download of everything stored for one client. Core authorizes (workspace:manage,
 * owner or admin), builds the file without secrets, and audits the export (counts only).
 */
export async function GET(request: NextRequest) {
  const result = await workspaces_export_data({
    workspaceId: request.nextUrl.searchParams.get("workspaceId") ?? "",
  });
  if (!result.ok) {
    return new NextResponse(result.error.message, { status: STATUS[result.error.code] ?? 500 });
  }
  const { content, filename } = result.data as { content: string; filename: string };
  return new NextResponse(content, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
