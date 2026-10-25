import Link from "next/link";
import type { ReactNode } from "react";
import { statusLabel } from "@/lib/labels";

// Self-contained on purpose: badge tone names in ui.tsx are owned by the app-shell work, so status
// pills here carry their own classes and cannot break when those are renamed.
const TONES = {
  neutral: "bg-secondary text-secondary-foreground",
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
  info: "bg-info-bg text-info",
} as const;
type Tone = keyof typeof TONES;

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  // good: finished and fine
  active: "good",
  applied: "good",
  approved: "good",
  done: "good",
  published: "good",
  verified: "good",
  succeeded: "good",
  completed: "good",
  accepted: "good",
  ready: "good",
  // in flight or waiting on someone
  pending: "warn",
  pending_approval: "warn",
  awaiting_approval: "warn",
  unverified: "warn",
  // moving on its own
  queued: "info",
  running: "info",
  scheduled: "info",
  publishing: "info",
  in_progress: "info",
  // needs attention
  blocked: "bad",
  failed: "bad",
  conflict: "bad",
  rejected: "bad",
  suspended: "bad",
  disabled: "bad",
  error: "bad",
};

/** A status word as a coloured Badge: "pending_approval" reads "Waiting for approval". */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Pill tone={STATUS_TONES[status.toLowerCase()] ?? "neutral"}>
      {label ?? statusLabel(status)}
    </Pill>
  );
}

const tabClass = (current: boolean) =>
  `inline-flex items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
    current
      ? "border-brand font-semibold text-foreground"
      : "border-transparent text-muted-foreground hover:border-input hover:text-foreground"
  }`;

/** Underlined tab links for switching between views of one page. Scrolls sideways on a phone. */
export function TabLinks({
  label,
  items,
}: {
  label: string;
  items: { href: string; label: ReactNode; current: boolean }[];
}) {
  return (
    <nav aria-label={label} className="-mb-2 overflow-x-auto border-b border-border">
      <ul className="-mb-px flex">
        {items.map((it, i) => (
          <li key={i}>
            <Link
              href={it.href}
              aria-current={it.current ? "page" : undefined}
              className={tabClass(it.current)}
            >
              {it.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Small pill links (workspace switcher, status filters). */
export function PillLinks({
  label,
  items,
}: {
  label: string;
  items: { href: string; label: ReactNode; current: boolean }[];
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {items.map((it, i) => (
        <Link
          key={i}
          href={it.href}
          aria-current={it.current ? "page" : undefined}
          className={`rounded-full border px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
            it.current
              ? "border-foreground bg-foreground text-background"
              : "border-input bg-card text-foreground hover:bg-muted"
          }`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

/** Link styled as a button, for actions that navigate. */
export const linkButtonClass =
  "inline-flex min-h-(--control-h) items-center rounded-control border border-input bg-card px-4 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const primaryLinkButtonClass =
  "inline-flex min-h-(--control-h) items-center rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Compact form controls for filter bars. */
export const filterFieldClass =
  "min-h-(--control-h) rounded-control border border-input bg-card px-2 py-1.5 text-sm font-normal text-foreground";

/** Table pieces: header cell and body cell with comfortable density. */
export const thClass = "px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground";
export const tdClass = "px-3 py-(--row-py) align-top";

/** Horizontally scrolling, bordered table wrapper for narrow screens (keyboard-scrollable when it overflows). */
export { TableWrap } from "./table-wrap";
