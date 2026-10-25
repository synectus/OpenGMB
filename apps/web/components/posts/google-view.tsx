import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Pencil } from "lucide-react";
import type { locationsList, postsGoogleList } from "@opengmb/core";
import { locations_list, posts_googleList, posts_syncGoogle } from "../../app/_generated/actions";
import { getTimeFormat } from "../../lib/time-format-server";
import { ctaFullName, googleHeadline, googleNote, googleState, postsHref, typeName } from "../../lib/posts-lists";
import { Pill, filterFieldClass, linkButtonClass } from "../page-parts";
import { EmptyState, ErrorText, secondaryButtonClass } from "../ui";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
const err = (e: { code: string; message: string }) => `${e.code}: ${e.message}`;

/** What is live on one location's Google profile right now, including posts made outside this app. Read only. */
export async function GoogleView({
  ws,
  carry,
  scopeLocationIds,
  loc,
}: {
  ws?: string;
  /** The ?ws= deep link to keep in this view's links. */
  carry?: string;
  /** Set for a group or location scope: only these locations are offered. */
  scopeLocationIds?: string[];
  loc?: string;
}) {
  const t = await getTranslations("posts");
  const locResult = await locations_list({ workspaceId: ws, status: "active" });
  if (!locResult.ok) return <ErrorText message={err(locResult.error)} />;
  const locations = (locResult.data as Handler<typeof locationsList>).locations.filter(
    (l) => !scopeLocationIds || scopeLocationIds.includes(l.id),
  );
  if (locations.length === 0) {
    return (
      <EmptyState
        title={t("ggl.noActiveTitle")}
        action={
          <Link href="/locations" className={linkButtonClass}>
            {t("ggl.goToLocations")}
          </Link>
        }
      >
        {t("ggl.importBody")}
      </EmptyState>
    );
  }
  const current = locations.find((l) => l.id === loc) ?? locations[0]!;
  const name = current.title ?? current.name;
  // Viewing (or "Read again from Google") also refreshes SynGMB's stored copy, so All posts, the
  // Calendar and Home catch up now instead of at the next review sync. Its failure is not shown here.
  const [r] = await Promise.all([
    posts_googleList({ locationId: current.id }),
    posts_syncGoogle({ locationId: current.id }),
  ]);
  if (!r.ok) return <ErrorText message={err(r.error)} />;
  const { posts, truncated } = r.data as Handler<typeof postsGoogleList>;
  const tf = await getTimeFormat(carry);
  const readAt = tf.time(new Date(), ws);

  return (
    <section aria-label={t("ggl.section")} className="flex flex-col gap-4">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value="google" />
        {carry && <input type="hidden" name="ws" value={carry} />}
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">
          {t("ggl.location")}
          <select name="loc" defaultValue={current.id} className={filterFieldClass}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title ?? l.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={secondaryButtonClass}>
          {t("ggl.readAgain")}
        </button>
        <div className="flex flex-col text-[13px]">
          <strong>{googleHeadline(t, posts.length, name, truncated)}</strong>
          <span className="text-muted-foreground">
            {t("ggl.readAt", { time: readAt })}
          </span>
        </div>
      </form>

      {posts.length === 0 ? (
        <EmptyState
          title={t("ggl.noPostsTitle")}
          action={
            <Link href={postsHref({ view: "compose", ws: carry })} className={linkButtonClass}>
              {t("ggl.writeFor", { name })}
            </Link>
          }
        >
          <span className="inline-flex items-center gap-2">
            <Pencil aria-hidden className="size-4" />
            {t("ggl.noneFor", { name })}
          </span>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {posts.map((p) => {
            const state = googleState(t, p);
            const note = googleNote(t, p);
            return (
              <li
                key={p.name}
                className="flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card shadow-card"
              >
                {p.mediaUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- Google-hosted image URL
                  <img src={p.mediaUrl} alt="" className="h-40 w-full object-cover" loading="lazy" />
                )}
                <div className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Pill tone={state.tone}>{state.label}</Pill>
                    <span>{typeName(t, p.topicType)}</span>
                    {p.createTime && <span>{tf.date(p.createTime, ws)}</span>}
                  </div>
                  {p.managedHere && (
                    <span className="w-fit rounded-md border border-good-border bg-good-bg px-2 py-0.5 text-[11px] font-semibold text-good">
                      {t("ggl.fromSynGmb")}
                    </span>
                  )}
                  {p.eventTitle && <strong className="text-foreground">{p.eventTitle}</strong>}
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
                    {p.summary ?? t("common.noText")}
                  </p>
                  {note && (
                    <span className={`text-xs ${note.tone === "bad" ? "font-semibold text-bad" : "text-muted-foreground"}`}>
                      {note.text}
                    </span>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-muted-foreground">
                      {p.callToAction ? t("ggl.button", { name: ctaFullName(t, p.callToAction.actionType) }) : t("ggl.noButton")}
                    </span>
                    {p.searchUrl && (
                      <a
                        href={p.searchUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-semibold text-brand-text underline underline-offset-2"
                      >
                        {t("common.viewOnGoogle")}
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
