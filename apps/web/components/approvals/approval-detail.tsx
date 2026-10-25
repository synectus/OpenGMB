import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  postsEditGet,
  postsGet,
  profileChangeSetsGet,
  reviewRepliesList,
  reviewsGet,
} from "@opengmb/core";
import {
  posts_editGet,
  posts_get,
  profile_changeSets_get,
  reviewReplies_list,
  reviews_get,
} from "../../app/_generated/actions";
import { fieldLabel, formatApprovalTime, formatChangeValue, type ApprovalItem } from "../../lib/approvals";
import { ApprovalActions } from "../approval-actions";
import { editChangeRows } from "../../lib/post-edit-rows";
import { Pill } from "../page-parts";
import { Violations } from "../reply-panel";
import { ReviewStars } from "../review-stars";
import { getTimeFormat } from "../../lib/time-format-server";
import { ErrorText } from "../ui";
import { PostContentPreview } from "../posts/post-content-preview";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

type T = Awaited<ReturnType<typeof getTranslations>>;
const topicLabel = (t: T, topic: string) => (t.has(`topic.${topic}`) ? t(`topic.${topic}`) : topic);
const draftedByName = (t: T, item: ApprovalItem) =>
  item.provenance.createdSurface === "mcp" ? t("claudeViaMcp") : (item.provenance.createdByName ?? t("teamMember"));
const draftedBy = (t: T, item: ApprovalItem) =>
  item.provenance.createdSurface === "mcp"
    ? t("draftedByMcp")
    : t("draftedByName", { name: item.provenance.createdByName ?? t("teamMember") });
const errorText = (e: { code: string; message: string }) => `${e.code}: ${e.message}`;

const linkText =
  "text-[13px] font-bold text-brand-text underline underline-offset-2 hover:text-foreground";

function Shell({
  kind,
  title,
  subtitle,
  children,
}: {
  kind: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const t = useTranslations("approvals");
  return (
    <article className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <span className="text-xs font-bold uppercase tracking-wider text-brand-text">{kind}</span>
          <h2 className="mt-0.5 font-display text-xl font-bold leading-7">{title}</h2>
          {subtitle ? <span className="text-[13px] text-muted-foreground">{subtitle}</span> : null}
        </div>
        <Pill tone="warn">{t("pendingApproval")}</Pill>
      </div>
      {children}
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Buttons when core says the caller may decide; otherwise a read-only note. */
function Decision({
  item,
  redirectTo,
  note,
}: {
  item: ApprovalItem;
  redirectTo: string;
  note: string;
}) {
  const t = useTranslations("approvals.detail");
  return (
    <div className="flex flex-col gap-2">
      {item.can.approve || item.can.reject ? (
        <ApprovalActions type={item.type} id={item.id} redirectTo={redirectTo} />
      ) : (
        <p className="border-t border-border pt-4 text-sm text-muted-foreground">
          {t("readOnly")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {note} {t("keys")}
      </p>
    </div>
  );
}

function Dl({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="m-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

async function ReplyDetail({ item, redirectTo }: { item: ApprovalItem; redirectTo: string }) {
  const t = await getTranslations("approvals.detail");
  const tRoot = await getTranslations("approvals");
  if (!item.reviewId) return <ErrorText message={t("notFoundReview")} />;
  const tf = await getTimeFormat();
  const [reviewRes, repliesRes] = await Promise.all([
    reviews_get({ id: item.reviewId }),
    reviewReplies_list({ reviewId: item.reviewId }),
  ]);
  if (!reviewRes.ok) return <ErrorText message={errorText(reviewRes.error)} />;
  const review = (reviewRes.data as Handler<typeof reviewsGet>).review;
  const revision = repliesRes.ok
    ? ((repliesRes.data as Handler<typeof reviewRepliesList>).revisions.find(
        (r) => r.id === item.id,
      ) ?? null)
    : null;
  return (
    <Shell
      kind={t("replyKind")}
      title={`${item.workspaceName} · ${item.locationNames[0] ?? ""}`}
      subtitle={revision ? t("revision", { n: revision.revision, status: tRoot("pendingApproval") }) : undefined}
    >
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <ReviewStars rating={review.rating} />
          <strong>
            {review.reviewer.isAnonymous ? t("anonymous") : (review.reviewer.displayName ?? t("unknown"))}
          </strong>
          <span className="text-[13px] text-muted-foreground">
            {review.location.name} · {tf.date(review.createTime, item.workspaceId)}
          </span>
        </div>
        <p className="whitespace-pre-wrap">{review.comment ?? t("noWrittenReview")}</p>
      </div>

      <Section title={t("proposedReply")}>
        <blockquote className="m-0 whitespace-pre-wrap rounded-xl border border-border bg-card px-4 py-3.5 leading-[22px]">
          {revision?.body ?? item.text}
        </blockquote>
        <Link href={`/reviews?review=${item.reviewId}`} className={linkText}>
          {t("openInReviews")}
        </Link>
      </Section>

      <Section title={t("guardrails")}>
        {revision?.guardrail ? (
          <Violations result={revision.guardrail} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("noGuardrail")}</p>
        )}
        {item.guardrail.warnings > 0 && item.guardrail.warningsAcknowledged ? (
          <p className="text-[13px] font-semibold text-good">
            {t("writerAcknowledged")}
          </p>
        ) : null}
      </Section>

      <Section title={t("history")}>
        <ol className="flex flex-col gap-2 text-[13px]">
          <li>
            <strong>{draftedBy(t, item)}</strong>
            {revision ? (
              <span className="text-muted-foreground"> · {formatApprovalTime(tf, revision.createdAt, item.workspaceId)}</span>
            ) : null}
          </li>
          <li>
            <strong>{t("submittedForApproval")}</strong>
            <span className="text-muted-foreground"> · {formatApprovalTime(tf, item.submittedAt, item.workspaceId)}</span>
          </li>
        </ol>
      </Section>

      <Decision
        item={item}
        redirectTo={redirectTo}
        note={t("noteReply")}
      />
    </Shell>
  );
}

async function PostDetail({ item, redirectTo }: { item: ApprovalItem; redirectTo: string }) {
  const t = await getTranslations("approvals.detail");
  const tf = await getTimeFormat();
  const res = await posts_get({ id: item.id });
  if (!res.ok) return <ErrorText message={errorText(res.error)} />;
  const post = (res.data as Handler<typeof postsGet>).post;
  return (
    <Shell
      kind={t("postKind", { topic: topicLabel(t, post.topicType) })}
      title={item.title}
      subtitle={`${item.workspaceName} · ${item.locationNames.join(", ")}`}
    >
      <PostContentPreview post={post} />

      <Section title={t("guardrails")}>
        {post.guardrail ? (
          <Violations result={post.guardrail} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("noGuardrail")}</p>
        )}
      </Section>

      <Dl
        rows={[
          [t("locations"), item.locationNames.join(", ")],
          [t("send"), post.scheduledFor ? t("sendAfterApproval", { when: formatApprovalTime(tf, post.scheduledFor, item.workspaceId) }) : t("notScheduled")],
          [
            t("draftedByLabel"),
            `${draftedByName(t, item)} · ${formatApprovalTime(tf, post.createdAt, item.workspaceId)}`,
          ],
          [t("submitted"), formatApprovalTime(tf, item.submittedAt, item.workspaceId)],
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/posts?view=list&ws=${item.workspaceId}&post=${item.id}`} className={linkText}>
          {t("openInPosts")}
        </Link>
      </div>
      <Decision
        item={item}
        redirectTo={redirectTo}
        note={t("notePost")}
      />
    </Shell>
  );
}

async function PostEditDetail({ item, redirectTo }: { item: ApprovalItem; redirectTo: string }) {
  const t = await getTranslations("approvals.detail");
  const tf = await getTimeFormat();
  if (!item.postId) return <ErrorText message={t("notFoundPost")} />;
  const [postRes, editRes] = await Promise.all([posts_get({ id: item.postId }), posts_editGet({ id: item.postId })]);
  if (!postRes.ok) return <ErrorText message={errorText(postRes.error)} />;
  if (!editRes.ok) return <ErrorText message={errorText(editRes.error)} />;
  const post = (postRes.data as Handler<typeof postsGet>).post;
  const edit = (editRes.data as Handler<typeof postsEditGet>).edit;
  if (!edit || edit.id !== item.id) return <ErrorText message={t("notFoundEdit")} />;
  const rows = editChangeRows(post, edit, edit.changedFields);
  return (
    <Shell
      kind={t("postEditKind", { topic: topicLabel(t, post.topicType) })}
      title={item.title}
      subtitle={`${item.workspaceName} · ${item.locationNames.join(", ")}`}
    >
      <div className="overflow-hidden rounded-xl border border-border text-[13px]">
        {rows.map((r) => (
          <div key={r.field} className="flex flex-col gap-1 border-b border-border p-3 last:border-b-0">
            <span className="text-xs font-semibold text-muted-foreground">{r.label}</span>
            <div className="grid grid-cols-1 gap-2 leading-[19px] sm:grid-cols-2">
              <div className="rounded-lg bg-bad-bg p-2.5 text-bad">
                <strong className="block text-[11px] uppercase tracking-wide">{t("onGoogleNow")}</strong>
                <pre className="m-0 whitespace-pre-wrap break-words font-sans">{r.now}</pre>
              </div>
              <div className="rounded-lg bg-good-bg p-2.5 text-good">
                <strong className="block text-[11px] uppercase tracking-wide">{t("proposed")}</strong>
                <pre className="m-0 whitespace-pre-wrap break-words font-sans">{r.next}</pre>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Section title={t("guardrails")}>
        {edit.guardrail ? (
          <Violations result={edit.guardrail} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("noGuardrail")}</p>
        )}
        {item.guardrail.warnings > 0 && item.guardrail.warningsAcknowledged ? (
          <p className="text-[13px] font-semibold text-good">
            {t("writerAcknowledged")}
          </p>
        ) : null}
      </Section>

      <Dl
        rows={[
          [t("locations"), item.locationNames.join(", ")],
          [
            t("proposedByLabel"),
            `${draftedByName(t, item)} · ${formatApprovalTime(tf, item.submittedAt, item.workspaceId)}`,
          ],
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/posts?view=list&ws=${item.workspaceId}&post=${item.postId}`} className={linkText}>
          {t("openInPosts")}
        </Link>
      </div>
      <Decision
        item={item}
        redirectTo={redirectTo}
        note={t("notePostEdit")}
      />
    </Shell>
  );
}

async function ChangeSetDetail({ item, redirectTo }: { item: ApprovalItem; redirectTo: string }) {
  const t = await getTranslations("approvals.detail");
  const tf = await getTimeFormat();
  const res = await profile_changeSets_get({ id: item.id });
  if (!res.ok) return <ErrorText message={errorText(res.error)} />;
  const cs = (res.data as Handler<typeof profileChangeSetsGet>).changeSet;
  const words = { notSet: t("notSet"), empty: t("empty") };
  const targets = cs.targets.filter((t) => t.status !== "no_change");
  return (
    <Shell
      kind={t("changeSetKind")}
      title={item.title}
      subtitle={t(item.provenance.createdSurface === "mcp" ? "csSubtitleMcp" : "csSubtitle", {
        client: item.workspaceName,
        name: item.provenance.createdByName ?? t("teamMember"),
        time: formatApprovalTime(tf, item.submittedAt, item.workspaceId),
      })}
    >
      <div className="overflow-hidden rounded-xl border border-border text-[13px]">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border bg-muted text-xs font-semibold text-muted-foreground">
          <span className="px-3 py-2">{t("location")}</span>
          <span className="px-3 py-2">{t("fields")}</span>
        </div>
        {targets.map((t) => (
          <div key={t.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border last:border-b-0">
            <span className="px-3 py-2 font-semibold">{t.locationName}</span>
            <span className="px-3 py-2 text-muted-foreground">
              {t.changes.map((c) => fieldLabel(c.field)).join(", ")}
            </span>
          </div>
        ))}
      </div>

      {targets.map((tg, i) => (
        <details key={tg.id} open={i === 0} className="rounded-xl border border-border px-3 py-2.5">
          <summary className="cursor-pointer text-[13px] font-semibold">
            {tg.locationName}: {tg.changes.map((c) => fieldLabel(c.field)).join(", ")}
          </summary>
          <div className="mt-2.5 flex flex-col gap-3">
            {tg.changes.map((c) => (
              <div key={c.field} className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-muted-foreground">{fieldLabel(c.field)}</span>
                <div className="grid grid-cols-1 gap-2 text-[13px] leading-[19px] sm:grid-cols-2">
                  <div className="rounded-lg bg-bad-bg p-2.5 text-bad">
                    <strong className="block text-[11px] uppercase tracking-wide">{t("onGoogleNow")}</strong>
                    <pre className="m-0 whitespace-pre-wrap break-words font-sans">{formatChangeValue(c.before, words)}</pre>
                  </div>
                  <div className="rounded-lg bg-good-bg p-2.5 text-good">
                    <strong className="block text-[11px] uppercase tracking-wide">{t("proposed")}</strong>
                    <pre className="m-0 whitespace-pre-wrap break-words font-sans">{formatChangeValue(c.after, words)}</pre>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}

      <Section title={t("guardrails")}>
        {cs.guardrail ? (
          <Violations result={cs.guardrail} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("noGuardrail")}</p>
        )}
        {item.guardrail.warnings > 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {t("csWarnings")}
          </p>
        ) : null}
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/locations/bulk-edit?ws=${item.workspaceId}`} className={linkText}>
          {t("openInBulk")}
        </Link>
      </div>
      <Decision
        item={item}
        redirectTo={redirectTo}
        note={t("noteChangeSet")}
      />
    </Shell>
  );
}

export async function ApprovalDetail({
  item,
  redirectTo,
}: {
  item: ApprovalItem;
  redirectTo: string;
}) {
  if (item.type === "reply") return <ReplyDetail item={item} redirectTo={redirectTo} />;
  if (item.type === "post") return <PostDetail item={item} redirectTo={redirectTo} />;
  if (item.type === "postedit") return <PostEditDetail item={item} redirectTo={redirectTo} />;
  return <ChangeSetDetail item={item} redirectTo={redirectTo} />;
}
