import type { InputHTMLAttributes, ReactNode } from "react";
import { shellBrand, type ShellBrand } from "../lib/theme/brand";

/**
 * Auth pages (sign in, sign up, two-factor, invitation): a brand row, one centred card that is the
 * page's <main> (the e2e hydration wait looks inside main), and an optional note under the card.
 * No app shell. `brand` is the SynGMB mark unless a caller passes an agency's (shellBrand).
 */
export function Card({
  title,
  eyebrow,
  description,
  note,
  brand = shellBrand(null),
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  note?: string;
  brand?: ShellBrand;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-muted text-foreground">
      <div className="flex items-center gap-2.5 px-4 py-6 sm:px-8">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- agency-supplied https URL, not optimised by next/image
          <img src={brand.logoUrl} alt="" height={32} className="h-8 w-auto" />
        ) : (
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-control bg-brand font-display text-lg font-extrabold text-brand-foreground"
          >
            {brand.mark}
          </span>
        )}
        <span className="font-display text-xl font-extrabold">{brand.name}</span>
        <span className="text-sm text-muted-foreground">{brand.subline}</span>
      </div>
      <main className="mx-4 my-6 flex flex-col gap-5 rounded-panel border border-border bg-card p-6 shadow-card sm:mx-auto sm:my-12 sm:w-full sm:max-w-[440px] sm:p-8">
        <div className="flex flex-col gap-1.5">
          {eyebrow ? (
            <span className="text-xs font-bold tracking-wide text-brand-text uppercase">{eyebrow}</span>
          ) : null}
          <h1 className="font-display text-2xl leading-[30px] font-extrabold">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {children}
      </main>
      {note ? (
        <p className="px-4 pb-8 text-center text-[13px] text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  id,
  ...props
}: { label: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <input id={id} name={id} className={inputClass} {...props} />
    </div>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm font-medium text-bad">
      {message}
    </p>
  ) : null;
}

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export const buttonClass = `inline-flex min-h-(--control-h) items-center justify-center gap-2 rounded-control bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-card hover:bg-primary-hover disabled:opacity-50 ${focusRing}`;
export const secondaryButtonClass = `inline-flex min-h-(--control-h) items-center justify-center gap-2 rounded-control border border-input bg-card px-4 py-1.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50 ${focusRing}`;

/** Destructive action (Disconnect, Remove, Revoke, Delete). The confirm stays the native window.confirm. */
export const destructiveButtonClass = `inline-flex min-h-9 items-center justify-center gap-2 rounded-control border border-bad-border bg-bad-bg px-3.5 text-sm font-semibold text-bad hover:bg-card disabled:opacity-50 ${focusRing}`;
export const inputClass =
  "min-h-(--control-h) rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring";
export const linkClass =
  "text-sm font-semibold text-brand-text underline underline-offset-2 hover:text-foreground";

/** Page title block: h1, a plain-language line about what the page is for, optional actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-[28px] leading-[34px] font-extrabold tracking-tight text-foreground">{title}</h1>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A bordered white surface with an optional heading. */
export function Panel({
  title,
  description,
  children,
  className = "",
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex flex-col gap-3 rounded-panel border border-border bg-card p-(--panel-p) shadow-card ${className}`}
    >
      {title ? (
        <div className="flex flex-col gap-0.5">
          <h2 className="font-display text-base font-bold text-foreground">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Nothing here yet: say what the page will hold and what to do next. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-panel border border-dashed border-input bg-card px-6 py-10 text-center">
      <p className="font-display font-bold text-foreground">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "bg-secondary text-secondary-foreground",
  success: "bg-good-bg text-good",
  warning: "bg-warn-bg text-warn",
  danger: "bg-bad-bg text-bad",
  info: "bg-info-bg text-info",
} as const;

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE_TONES[tone]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
