import { headers } from "next/headers";

/**
 * An inline <style> tag the Content-Security-Policy lets through: it carries this request's nonce,
 * set by proxy.ts. `css` must be trusted (token values and validated brand colours), never user text.
 */
export async function NonceStyle({ css }: { css: string }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <style nonce={nonce} dangerouslySetInnerHTML={{ __html: css }} />;
}
