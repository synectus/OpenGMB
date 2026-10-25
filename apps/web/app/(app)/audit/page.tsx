import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { auditList, membersList } from "@opengmb/core";
import { AuditTable, type AuditRow } from "../../../components/audit-table";
import { AuditTools } from "../../../components/audit-tools";
import { filterFieldClass } from "../../../components/page-parts";
import { SettingsShell } from "../../../components/settings/settings-shell";
import { EmptyState, ErrorText, linkClass, secondaryButtonClass } from "../../../components/ui";
import {
  AUDIT_PAGE,
  AUDIT_SURFACES,
  auditHref,
  olderBefore,
  pageNote,
  parseBefore,
  parseSurface,
} from "../../../lib/audit-view";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { audit_list, members_list } from "../../_generated/actions";
import { EmptyNext } from "../../../components/empty-next";

type Listed = Awaited<ReturnType<typeof auditList.handler>>;
type Members = Awaited<ReturnType<typeof membersList.handler>>;
type Search = { surface?: string; actor?: string; before?: string };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations("audit");
  const { userId } = await requireUser();
  const { organization, role } = await actorContextFor(userId);
  const sp = await searchParams;
  const surface = parseSurface(sp.surface);
  const actor = sp.actor?.trim() || undefined;
  const before = parseBefore(sp.before);

  const [result, membersRes] = await Promise.all([
    audit_list({ limit: AUDIT_PAGE + 1, beforeId: before, surface, actorUserId: actor }),
    members_list({}),
  ]);
  // 5B's frame: same props on every branch, so the sub-nav shows "Audit log" as current.
  const frame = {
    current: "/audit",
    role,
    title: t("title"),
    description: t("description"),
  } as const;
  if (!result.ok) {
    return (
      <SettingsShell {...frame}>
        {result.error.code === "FORBIDDEN" ? (
          <p role="alert" className="text-sm text-bad">
            {t("forbidden")}
          </p>
        ) : (
          <ErrorText message={`${result.error.code}: ${result.error.message}`} />
        )}
      </SettingsShell>
    );
  }

  const fetched = (result.data as Listed).entries;
  const rows: AuditRow[] = fetched.slice(0, AUDIT_PAGE);
  const older = olderBefore(fetched, AUDIT_PAGE);
  const filtered = surface !== undefined || actor !== undefined;
  // One option per person; a member listed in several workspaces appears once.
  const people = membersRes.ok
    ? [...new Map((membersRes.data as Members).members.map((m) => [m.userId, m.name])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
    : [];

  return (
    <SettingsShell {...frame}>
      <AuditTools orgId={organization.id} />

      <form method="get" action="/audit" aria-label={t("filters")} className="flex flex-wrap items-end gap-2.5">
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
          {t("surface")}
          <select name="surface" defaultValue={surface ?? ""} className={filterFieldClass}>
            <option value="">{t("all")}</option>
            {AUDIT_SURFACES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground">
          {t("actor")}
          <select name="actor" defaultValue={actor ?? ""} className={filterFieldClass}>
            <option value="">{t("all")}</option>
            {people.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={secondaryButtonClass}>
          {t("filter")}
        </button>
        {filtered && (
          <Link href="/audit" className={linkClass}>
            {t("clear")}
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        filtered || before !== undefined ? (
          <EmptyState title={t("noMatch")}>
            {before !== undefined ? t("noMatchBodyOlder", { id: String(before) }) : t("noMatchBody")}
          </EmptyState>
        ) : (
          <EmptyNext id="audit" />
        )
      ) : (
        <>
          <AuditTable rows={rows} />
          <div className="flex flex-wrap items-center gap-3">
            {older !== null && (
              <Link
                href={auditHref({ surface, actor, before: older })}
                className={secondaryButtonClass}
              >
                {t("older")}
              </Link>
            )}
            {before !== undefined && (
              <Link href={auditHref({ surface, actor })} className={linkClass}>
                {t("newest")}
              </Link>
            )}
            <span className="text-sm text-muted-foreground">{pageNote(before, rows.length)}</span>
          </div>
        </>
      )}
    </SettingsShell>
  );
}
