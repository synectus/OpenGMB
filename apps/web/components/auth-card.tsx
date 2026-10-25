import type { ComponentProps } from "react";
import { Card } from "./ui";
import { NonceStyle } from "./nonce-style";
import { currentHostBrand } from "../lib/host-branding";

/**
 * Card for the signed-out pages. On an agency's own address it carries the agency's name, logo and
 * colours; on the main host it is the plain Card. A caller's own `brand` (the invitation's) is used on the main host.
 */
export async function AuthCard(props: ComponentProps<typeof Card>) {
  const host = await currentHostBrand();
  return (
    <>
      {host?.css ? <NonceStyle css={host.css} /> : null}
      <Card {...props} brand={host?.brand ?? props.brand} />
    </>
  );
}
