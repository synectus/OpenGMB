// apps/web/components/share/share-frame.tsx
import type { ReactNode } from "react";
import { brandCss } from "../../lib/theme/brand";
import { NonceStyle } from "../nonce-style";

export type FrameBrand = { agencyName: string; colour: string | null; logoUrl: string | null };

/** The public share page's frame: agency colours (token overrides), logo or mark, name. */
export function ShareFrame({
  brand,
  right,
  children,
  footer,
}: {
  brand: FrameBrand | null;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const name = brand?.agencyName ?? "OpenGMB";
  const css = brand?.colour
    ? brandCss({ primaryColor: brand.colour, accentColor: brand.colour })
    : null;
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Token overrides built from a validated #rrggbb (brandCss refuses anything else). */}
      {css && <NonceStyle css={css} />}
      <div className="mx-auto flex max-w-[960px] flex-col gap-7 px-4 py-10 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-4">
          <div className="flex items-center gap-2.5">
            {brand?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- agency-supplied https URL
              <img
                src={brand.logoUrl}
                alt=""
                height={32}
                referrerPolicy="no-referrer"
                className="h-8 w-auto"
              />
            ) : (
              <span
                aria-hidden
                className="flex size-8 items-center justify-center rounded-[9px] bg-brand font-display text-lg font-extrabold text-brand-foreground"
              >
                {name.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="font-display text-xl font-extrabold">{name}</span>
          </div>
          {right}
        </header>
        <main className="flex flex-col gap-7">{children}</main>
        {footer && (
          <footer className="flex flex-col gap-1 border-t border-border pt-4">{footer}</footer>
        )}
      </div>
    </div>
  );
}

export function Denied({
  brand,
  title,
  body,
}: {
  brand: FrameBrand | null;
  title: string;
  body: string;
}) {
  return (
    <ShareFrame brand={brand}>
      <div className="flex flex-col gap-2 py-10">
        <h1 className="font-display text-2xl font-extrabold">{title}</h1>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </ShareFrame>
  );
}
