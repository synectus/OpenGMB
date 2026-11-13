/**
 * True for a bot POSTing a junk body with a Next-Action header: Next's server-action decoder throws
 * "Failed to parse body as FormData." before any of our code runs. It is not a bug in the app, so it
 * is not recorded as an error (Recent errors table, alert email). Anything else is still recorded.
 */
export function isServerActionProbe(
  err: unknown,
  request: { headers?: Record<string, string | string[] | undefined> } | undefined,
): boolean {
  return (
    err instanceof TypeError &&
    err.message === "Failed to parse body as FormData." &&
    request?.headers?.["next-action"] !== undefined
  );
}
