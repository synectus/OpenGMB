// Liveness for the platform health check; no database or session involved.
export function GET() {
  return Response.json({ ok: true });
}
