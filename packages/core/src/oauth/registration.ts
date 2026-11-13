export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHttp(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/**
 * Applied to every POST /oauth2/register body before the plugin sees it. Redirect URIs must be https, or http on a
 * loopback host (desktop and CLI clients). A body whose redirect URIs are all loopback http and that names no
 * application_type is a native app: the plugin would otherwise treat it as "web" and refuse the loopback URI.
 */
export function normaliseRegistration<T extends Record<string, unknown>>(body: T): T & { application_type?: unknown } {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris)) return body;
  const urls = uris.map((raw) => {
    let u: URL;
    try {
      u = new URL(String(raw));
    } catch {
      throw new RegistrationError(`redirect URI must be an absolute URL: ${String(raw)}`);
    }
    if (u.protocol !== "https:" && !isLoopbackHttp(u)) {
      throw new RegistrationError(`redirect URI must be https, or http on localhost, 127.0.0.1 or [::1]: ${String(raw)}`);
    }
    return u;
  });
  if (body.application_type === undefined && urls.length > 0 && urls.every(isLoopbackHttp)) {
    return { ...body, application_type: "native" };
  }
  return body;
}
