"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  posts_approve,
  posts_approveEdit,
  profile_approve,
  reviewReplies_approve,
} from "../../app/_generated/actions";
import {
  ageParts,
  approvableKeys,
  approvalsHref,
  approveSequentially,
  bulkBlockKey,
  itemKey,
  itemLocationsText,
  pruneSelection,
  toggleAll,
  toggleKey,
  type ApprovalItem,
  type Tab,
} from "../../lib/approvals";
import { Pill } from "../page-parts";
import { buttonClass } from "../ui";
import { ProvenanceChip } from "./provenance-chip";

export function ApprovalList({
  items,
  selectedKey,
  tab,
  ws,
  loc,
  now,
}: {
  items: ApprovalItem[];
  selectedKey: string | null;
  tab: Tab;
  ws?: string;
  loc?: string;
  /** Server time in ms, so the "2 h" labels agree between the server render and hydration. */
  now: number;
}) {
  const t = useTranslations("approvals.list");
  const tRoot = useTranslations("approvals");
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ key: string; title: string; message: string }[]>([]);

  const ready = approvableKeys(items);
  // Derived on every render, so an item that left the queue or is no longer ready drops out.
  const live = pruneSelection(selected, items);

  async function approveSelected() {
    setBusy(true);
    setErrors([]);
    const chosen = items.filter((i) => live.includes(itemKey(i)));
    const out = await approveSequentially(chosen, (type, id) =>
      type === "reply"
        ? reviewReplies_approve({ id })
        : type === "post"
          ? posts_approve({ id })
          : type === "postedit"
            ? posts_approveEdit({ id })
            : profile_approve({ id }),
      t("requestFailed"),
    );
    setSelected((s) => s.filter((k) => !out.approved.includes(k)));
    setErrors(out.errors);
    setBusy(false);
    router.refresh();
  }

  return (
    <section
      aria-label={t("waitingItems")}
      className="flex min-w-0 flex-col border-b border-border bg-card lg:w-[400px] lg:shrink-0 lg:border-b-0 lg:border-r"
    >
      <div className="flex items-center gap-2.5 border-b border-border bg-muted px-3.5 py-2.5 text-[13px]">
        <input
          type="checkbox"
          aria-label={t("selectAll")}
          disabled={ready.length === 0 || busy}
          checked={ready.length > 0 && live.length === ready.length}
          onChange={() => setSelected(toggleAll(live, items))}
          className="size-4 accent-primary"
        />
        {live.length > 0 ? (
          <span>
            <strong>{t("selectedCount", { count: live.length })}</strong>{" "}
            <span className="text-muted-foreground">{t("ofReady", { count: ready.length })}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            {t("readyOfItems", { ready: ready.length, items: items.length })}
          </span>
        )}
        {live.length > 0 && (
          <button
            type="button"
            className={`${buttonClass} ml-auto`}
            disabled={busy}
            onClick={approveSelected}
          >
            {t("approveN", { count: live.length })}
          </button>
        )}
      </div>

      {errors.length > 0 && (
        <ul aria-label={t("errors")} className="flex flex-col gap-1 border-b border-border px-3.5 py-2.5">
          {errors.map((e) => (
            <li key={e.key} role="alert" className="text-sm font-medium text-bad">
              {e.title}: {e.message}
            </li>
          ))}
        </ul>
      )}

      <ul>
        {items.map((i) => {
          const key = itemKey(i);
          const reasonKey = bulkBlockKey(i);
          const reason = reasonKey === null ? null : t(`block.${reasonKey}`);
          const current = key === selectedKey;
          const age = ageParts(i.submittedAt, now);
          return (
            <li
              key={key}
              className={`flex gap-2.5 border-b border-l-4 border-b-border px-3.5 py-3 ${
                current ? "border-l-primary bg-brand-tint" : "border-l-transparent"
              }`}
            >
              <input
                type="checkbox"
                aria-label={t("selectItem", { title: i.title })}
                disabled={reason !== null || busy}
                title={reason ?? undefined}
                checked={live.includes(key)}
                onChange={() => setSelected(toggleKey(live, key))}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <Link
                href={approvalsHref({ tab, ws, loc, item: key })}
                aria-current={current ? "true" : undefined}
                className="flex min-w-0 flex-1 flex-col gap-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span className="flex items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-brand-text">
                    {t(`type.${i.type}`)}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {age ? t(`age.${age.unit}`, { n: age.n }) : ""}
                  </span>
                </span>
                <strong className="truncate font-semibold">{i.title}</strong>
                <span className="truncate text-[13px] text-muted-foreground">
                  {i.workspaceName} · {itemLocationsText(i)}
                </span>
                <span className="mt-0.5 flex flex-wrap gap-1.5">
                  <Pill tone="warn">{tRoot("pendingApproval")}</Pill>
                  <ProvenanceChip
                    surface={i.provenance.createdSurface}
                    name={i.provenance.createdByName}
                  />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="px-3.5 py-2.5 text-xs text-muted-foreground">
        {t("bulkNote")}
      </p>
    </section>
  );
}
