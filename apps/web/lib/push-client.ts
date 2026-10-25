// Pure helpers for the "alerts on this device" control. Client-safe.

/** The VAPID public key is base64url text; the browser wants its bytes. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type StoredSubscription = { endpoint: string; p256dh: string; auth: string };

/** Validate the body the browser's PushSubscription.toJSON() produces; null when it is not one. */
export function parseSubscriptionBody(body: unknown): StoredSubscription | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const { endpoint } = b;
  const p256dh = b.keys?.p256dh;
  const auth = b.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 2048) return null;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (!p256dh || !auth || p256dh.length > 256 || auth.length > 256) return null;
  return { endpoint, p256dh, auth };
}
