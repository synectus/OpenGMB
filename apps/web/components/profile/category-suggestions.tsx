"use client";
import Link from "next/link";
import { statusWords } from "@/lib/labels";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { profile_categories_search, profile_preview, profile_propose } from "../../app/_generated/actions";
import { approvalsHref, itemKey } from "../../lib/approvals";
import { runCall } from "../post-card";
import { buttonClass, ErrorText, linkClass } from "../ui";
import { hintClass } from "./section";

export type Suggestion = {
  name: string;
  competitors: number;
  asPrimary: number;
  evidence: { placeId: string; title: string; rank: number; appearances: number; isPrimary: boolean }[];
};

type Done = { kind: "recorded"; id: string; status: string } | { kind: "already" };

/** One suggestion per row; "Add to profile" resolves the Google category, previews, and records a change set that waits for approval. */
export function CategorySuggestions({
  locationId,
  workspaceId,
  suggestions,
  total,
  display,
  canEdit,
}: {
  locationId: string;
  workspaceId: string;
  suggestions: Suggestion[];
  total: number;
  display: { regionCode: string; languageCode: string };
  canEdit: boolean;
}) {
  const t = useTranslations("profile");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, Done>>({});

  async function add(name: string) {
    setBusy(name);
    setErrors((e) => ({ ...e, [name]: "" }));
    const fail = (m: string) => {
      setBusy(null);
      setErrors((e) => ({ ...e, [name]: m }));
    };
    const found = await runCall<{ categories: { name: string; displayName: string }[] }>(() =>
      profile_categories_search({ locationId, ...display, query: name }),
    );
    if ("error" in found) return fail(found.error);
    const match = found.data.categories.find((c) => c.displayName.toLowerCase() === name.toLowerCase());
    if (!match) return fail(t("suggest.noMatch", { name }));
    const add = [{ name: match.name }];
    const prev = await runCall<{ locations: { error: string | null; noChange: boolean; current: Record<string, unknown> | null }[] }>(() =>
      profile_preview({ locationIds: [locationId], fields: {}, addCategories: add }),
    );
    if ("error" in prev) return fail(prev.error);
    const l = prev.data.locations[0];
    if (!l || l.error || !l.current) return fail(l?.error ?? "NOT_FOUND");
    if (l.noChange) {
      setBusy(null);
      return setDone((d) => ({ ...d, [name]: { kind: "already" } }));
    }
    const r = await runCall<{ changeSet: { id: string; status: string } }>(() =>
      profile_propose({
        workspaceId,
        locationIds: [locationId],
        fields: {},
        addCategories: add,
        snapshots: [{ locationId, current: l.current! }],
      }),
    );
    if ("error" in r) return fail(r.error);
    setBusy(null);
    setDone((d) => ({ ...d, [name]: { kind: "recorded", id: r.data.changeSet.id, status: r.data.changeSet.status } }));
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {suggestions.map((s) => {
        const d = done[s.name];
        return (
          <li key={s.name} className="flex flex-col gap-2 rounded-control border border-border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <strong>{s.name}</strong>
                <p className={hintClass}>{t("suggest.usedBy", { count: s.competitors, total, primary: s.asPrimary })}</p>
              </div>
              {canEdit && !d && (
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy !== null}
                  aria-label={t("suggest.addLabel", { name: s.name })}
                  onClick={() => add(s.name)}
                >
                  {busy === s.name ? t("suggest.adding") : t("suggest.add")}
                </button>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("suggest.who")}</summary>
              <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-[13px]">
                {s.evidence.map((e) => (
                  <li key={e.placeId}>
                    <span className="font-medium">{t("suggest.rank", { rank: e.rank })}</span> {e.title}
                    <span className="text-muted-foreground">
                      {" "}
                      · {t("suggest.gridPoints", { count: e.appearances })}
                      {e.isPrimary ? ` · ${t("suggest.mainTag")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
            <ErrorText message={errors[s.name] || null} />
            {d?.kind === "already" && <p role="status" className={hintClass}>{t("suggest.alreadyThere")}</p>}
            {d?.kind === "recorded" && (
              <p role="status" className="rounded-control border border-good-border bg-good-bg px-3 py-2 text-[13px] text-good">
                {t("suggest.recorded", { status: statusWords(d.status) })}{" "}
                <Link href={approvalsHref({ tab: "changeset", item: itemKey({ type: "changeset", id: d.id }) })} className={linkClass}>
                  {t("suggest.review")}
                </Link>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
