import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { locationsList, postsGet, postsList } from "@opengmb/core";
import { locations_list, posts_get, posts_list } from "../../app/_generated/actions";
import {
  POST_STATUSES,
  POST_TYPES,
  authorLabel,
  isUuid,
  locationsCell,
  nextSendCell,
  parseStatus,
  parseType,
  statusText,
  googlePostTitle,
  postTitle,
  postsHref,
  typeName,
} from "../../lib/posts-lists";
import { getTimeFormat } from "../../lib/time-format-server";
import { PostCard } from "../post-card";
import {
  StatusBadge,
  TableWrap,
  filterFieldClass,
  linkButtonClass,
  tdClass,
  thClass,
} from "../page-parts";
import { EmptyState, ErrorText, secondaryButtonClass } from "../ui";
import { EmptyNext } from "../empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const LIMIT = 100;
const err = (e: { code: string; message: string }) => `${e.code}: ${e.message}`;

export async function ListView({
  ws,
  carry,
  scopeLocationIds,
  scopeName,
  status,
  type,
  q,
  post,
  writesOff,
}: {
  ws?: string;
  /** The ?ws= deep link to keep in this view's links. */
  carry?: string;
  /** Set for a group or location scope: only posts that target one of these are listed. */
  scopeLocationIds?: string[];
  /** "Rivermoor Pain Clinic", or "all clients". */
  scopeName: string;
  status?: string;
  type?: string;
  q?: string;
  post?: string;
  writesOff: boolean;
}) {
  const t = await getTranslations("posts");
  const tf = await getTimeFormat(carry);
  const st = parseStatus(status);
  const ty = parseType(type);
  const text = q?.trim() || undefined;
  const focusId = isUuid(post) ? post : undefined;
  const [listRes, locRes, focusRes] = await Promise.all([
    posts_list({ workspaceId: ws, status: st, topicType: ty, q: text, limit: LIMIT }),
    locations_list({ workspaceId: ws, status: "active" }),
    focusId ? posts_get({ id: focusId }) : Promise.resolve(null),
  ]);
  if (!listRes.ok) return <ErrorText message={err(listRes.error)} />;
  const listed = listRes.data as Handler<typeof postsList>;
  const items = listed.posts.filter(
    (p) => !scopeLocationIds || p.targets.some((x) => scopeLocationIds.includes(x.locationId)),
  );
  // Posts made outside SynGMB (Google's own app or another tool): read-only rows, no SynGMB actions.
  const onGoogle = listed.googleOnly.filter((g) => !scopeLocationIds || scopeLocationIds.includes(g.locationId));
  const total = items.length + onGoogle.length;
  const active = new Map<string, number>();
  if (locRes.ok) {
    for (const l of (locRes.data as Handler<typeof locationsList>).locations) {
      active.set(l.workspaceId, (active.get(l.workspaceId) ?? 0) + 1);
    }
  }
  const focus = focusRes?.ok ? (focusRes.data as Handler<typeof postsGet>).post : null;
  const filtered = Boolean(st || ty || text);
  const keep = { ws: carry, status: st, type: ty, q: text };

  return (
    <section aria-label={t("list.section")} className="flex flex-col gap-4">
      <form method="get" aria-label={t("list.filters")} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value="list" />
        {carry && <input type="hidden" name="ws" value={carry} />}
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          {t("list.status")}
          <select name="status" defaultValue={st ?? ""} className={filterFieldClass}>
            <option value="">{t("list.allStatuses")}</option>
            {POST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusText(t, s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          {t("list.type")}
          <select name="type" defaultValue={ty ?? ""} className={filterFieldClass}>
            <option value="">{t("list.allTypes")}</option>
            {POST_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {typeName(t, pt)}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          name="q"
          aria-label={t("list.searchText")}
          placeholder={t("list.searchText")}
          defaultValue={text ?? ""}
          className={`${filterFieldClass} min-w-56`}
        />
        <button type="submit" className={secondaryButtonClass}>
          {t("list.filter")}
        </button>
        <span className="text-[13px] text-muted-foreground">
          {items.length >= LIMIT
            ? t("list.countCapped", { count: total, scope: scopeName, limit: LIMIT })
            : t("list.count", { count: total, scope: scopeName })}
        </span>
      </form>

      {total === 0 ? (
        st && !ty && !text ? (
          <EmptyState
            title={t("list.emptyStatusTitle")}
            action={
              <Link href={postsHref({ view: "list", ws: carry })} className={secondaryButtonClass}>
                {t("list.showAllStatuses")}
              </Link>
            }
          >
            {t("list.emptyStatusBody")}
          </EmptyState>
        ) : filtered ? (
          <EmptyState
            title={t("list.emptyFilterTitle")}
            action={
              <Link href={postsHref({ view: "list", ws: carry })} className={secondaryButtonClass}>
                {t("list.clearFilters")}
              </Link>
            }
          >
            {t("list.emptyFilterBody")}
          </EmptyState>
        ) : (
          <EmptyNext id="posts" href={postsHref({ view: "compose", ws: carry })} />
        )
      ) : (
        <TableWrap>
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                {(["colPost", "colType", "colLocations", "colStatus", "colNextSend", "colWrittenBy", "colLink"] as const).map((h) => (
                  <th key={h} scope="col" className={thClass}>
                    {t(`list.${h}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  className={`border-t border-border ${p.id === focusId ? "bg-brand-tint shadow-[inset_3px_0_0_var(--brand)]" : ""}`}
                >
                  <td className={tdClass}>
                    <Link
                      href={postsHref({ view: "list", ...keep, post: p.id })}
                      aria-current={p.id === focusId ? "true" : undefined}
                      className="font-semibold text-brand-text underline underline-offset-2"
                    >
                      {postTitle(t, p)}
                    </Link>
                  </td>
                  <td className={tdClass}>{typeName(t, p.topicType)}</td>
                  <td className={tdClass}>{locationsCell(t, p, active.get(p.workspaceId))}</td>
                  <td className={tdClass}>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className={tdClass}>{nextSendCell(t, p, tf)}</td>
                  <td
                    className={`${tdClass} ${p.createdSurface === "mcp" ? "font-semibold text-agent" : ""}`}
                  >
                    {authorLabel(t, p)}
                  </td>
                  <td className={tdClass} />
                </tr>
              ))}
              {onGoogle.map((g) => (
                <tr key={g.id} className="border-t border-border">
                  <td className={tdClass}>
                    <span className="font-semibold">{googlePostTitle(t, g)}</span>
                  </td>
                  <td className={tdClass}>{typeName(t, g.topicType)}</td>
                  <td className={tdClass}>{g.locationName}</td>
                  <td className={tdClass}>
                    <StatusBadge status="made_on_google" label={t("common.madeOnGoogle")} />
                  </td>
                  <td className={tdClass}>{g.at ? tf.date(g.at, g.workspaceId) : "–"}</td>
                  <td className={tdClass}>{t("common.madeOnGoogle")}</td>
                  <td className={tdClass}>
                    {g.searchUrl ? (
                      <a
                        href={g.searchUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold text-brand-text underline underline-offset-2"
                      >
                        {t("common.viewOnGoogle")}
                      </a>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      {focusRes && !focus && focusRes.ok === false && <ErrorText message={err(focusRes.error)} />}
      {focus && (
        <section aria-label={t("list.selectedPost")} className="flex flex-col gap-2">
          <Link href={postsHref({ view: "list", ...keep })} className={linkButtonClass}>
            {t("common.close")}
          </Link>
          <PostCard key={focus.id} initial={focus} highlight writesOff={writesOff} />
        </section>
      )}
    </section>
  );
}
