import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  approvalsCounts,
  locationsList,
  replyTemplatesList,
  reviewRepliesList,
  reviewNotesList,
  reviewRepliesListQueue,
  reviewsAssignees,
  reviewsAssignments,
  reviewsGet,
  reviewsList,
  workspaceSettingsGet,
  workspacesList,
} from "@opengmb/core";
import { REVIEWS_CONFIG, REVIEW_TOPIC_IDS, TOPIC_SENTIMENTS, roleHasPermission } from "@opengmb/core";
import { dayKey } from "@opengmb/core/time";
import { AutoApproveChip } from "../../../components/auto-approve-chip";
import { ChooseClient } from "../../../components/choose-client";
import { AnalyticsView } from "../../../components/reviews/analytics-view";
import { AssignPanel } from "../../../components/reviews/assign-panel";
import { BulkReplyView } from "../../../components/reviews/bulk-reply-view";
import { ExportDialog } from "../../../components/reviews/export-dialog";
import { RequestsView } from "../../../components/reviews/requests-view";
import { ReviewsTabs } from "../../../components/reviews/reviews-tabs";
import { ReplyPanel, type ReplyData, type TemplateOption } from "../../../components/reply-panel";
import { ReviewStars } from "../../../components/review-stars";
import { SyncNow } from "../../../components/reviews-sync";
import { EmptyState, ErrorText, PageHeader, secondaryButtonClass } from "../../../components/ui";
import {
  filterFieldClass,
  linkButtonClass,
  PillLinks,
  StatusBadge,
} from "../../../components/page-parts";
import { approvalsHref } from "../../../lib/approvals";
import { approvalSurfaces, queueRedirect } from "../../../lib/approval-surfaces";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { dayRange, parseQuery, parseSort, SORT_OPTIONS } from "../../../lib/review-filters";
import { parseSentiment, parseTopic } from "../../../lib/review-topics";
import type { TimeFormat } from "../../../lib/time-format";
import { getTimeFormat } from "../../../lib/time-format-server";
import { parseView } from "../../../lib/reviews-views";
import { autoApproveIds, narrowNote, scopeFilter } from "../../../lib/scope";
import { currentScope } from "../../../lib/scope-server";
import {
  approvals_counts,
  locations_list,
  replyTemplates_list,
  reviewReplies_list,
  reviewReplies_listQueue,
  reviewNotes_list,
  reviews_assignees,
  reviews_assignments,
  reviews_get,
  reviews_list,
  workspaceSettings_get,
  workspaces_list,
} from "../../_generated/actions";
import { EmptyNext } from "../../../components/empty-next";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;
type ReviewItem = Handler<typeof reviewsList>["items"][number];

type Search = {
  view?: string;
  qstatus?: string;
  ws?: string;
  loc?: string;
  group?: string;
  rating?: string | string[];
  replied?: string;
  from?: string;
  to?: string;
  period?: string;
  q?: string;
  sort?: string;
  cursor?: string;
  review?: string;
  /** Team-only filter: "me" (assigned to me) or "overdue". */
  assign?: string;
  /** A5: a review topic id, and a sentiment (that topic's, or the overall one without a topic). */
  topic?: string;
  sentiment?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | undefined) => (v && v.trim() ? v : undefined);

/** Templates per workspace, fetched once per page. Settings are read only to mark templates that render would refuse. */
async function loadTemplates(workspaceIds: Iterable<string>) {
  const out = new Map<string, TemplateOption[]>();
  await Promise.all(
    [...new Set(workspaceIds)].map(async (workspaceId) => {
      const [list, settings] = await Promise.all([
        replyTemplates_list({ workspaceId }),
        workspaceSettings_get({ workspaceId }),
      ]);
      if (!list.ok) return;
      const genericOnly =
        settings.ok && (settings.data as Handler<typeof workspaceSettingsGet>).genericTemplatesOnly;
      out.set(
        workspaceId,
        (list.data as Handler<typeof replyTemplatesList>).templates.map((t) => ({
          id: t.id,
          name: t.name,
          allowed: !genericOnly || t.generic,
        })),
      );
    }),
  );
  return out;
}

/** The approval-queue card: stars, who, where and when, state badges, the text, then the reply panel (children). */
function ReviewCard({
  rating,
  reviewer,
  meta,
  comment,
  badges,
  children,
}: {
  rating: number | null;
  reviewer: string;
  meta: string;
  comment: string | null;
  badges: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("reviews");
  return (
    <li
      className={`flex flex-col gap-3 rounded-xl border border-l-4 border-border bg-card p-4 shadow-sm ${
        rating !== null && rating <= 2 ? "border-l-bad" : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <ReviewStars rating={rating} />
          <span className="font-medium text-foreground">{reviewer}</span>
          {badges}
        </span>
        <span className="text-xs text-muted-foreground">{meta}</span>
      </div>
      {comment ? (
        <p className="whitespace-pre-wrap text-sm text-foreground">{comment}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noWritten")}</p>
      )}
      {children}
    </li>
  );
}

/** One compact row of the list: a link (never a button), the comment clamped to two lines. */
function ReviewRow({
  rating,
  reviewer,
  meta,
  comment,
  badge,
  href,
  selected,
  assigned,
}: {
  rating: number | null;
  reviewer: string;
  meta: string;
  comment: string | null;
  badge: ReactNode;
  href: string;
  selected: boolean;
  /** Team-only line: who has it and whether it is late. Null for client roles. */
  assigned?: ReactNode;
}) {
  const t = useTranslations("reviews");
  return (
    <li
      className={`border-b border-l-4 border-b-border ${
        selected
          ? "border-l-primary bg-brand-tint"
          : rating !== null && rating <= 2
            ? "border-l-bad"
            : "border-l-transparent"
      }`}
    >
      <Link
        href={href}
        aria-current={selected ? "true" : undefined}
        className="flex flex-col gap-1 px-3.5 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex items-center gap-2">
          <ReviewStars rating={rating} className="text-[13px]" />
          <strong className="truncate font-semibold">{reviewer}</strong>
          <span className="ml-auto shrink-0">{badge}</span>
        </span>
        <span className="text-xs text-muted-foreground">{meta}</span>
        {assigned}
        {comment ? (
          <span className="line-clamp-2 text-[13px] text-foreground">{comment}</span>
        ) : (
          <span className="text-[13px] text-muted-foreground">{t("noWritten")}</span>
        )}
      </Link>
    </li>
  );
}

/** The selected review in full. The reply panel (children) sits under it. */
function ReviewDetail({
  rating,
  reviewer,
  meta,
  comment,
  badge,
}: {
  rating: number | null;
  reviewer: string;
  meta: string;
  comment: string | null;
  badge: ReactNode;
}) {
  const t = useTranslations("reviews");
  return (
    <article className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary font-bold"
        >
          {reviewer.charAt(0).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <strong className="truncate">{reviewer}</strong>
          <span className="text-[13px] text-muted-foreground">{meta}</span>
        </div>
        <ReviewStars rating={rating} className="ml-auto text-lg" />
      </div>
      {comment ? (
        <p className="whitespace-pre-wrap text-[15px] leading-[23px]">{comment}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t("noWritten")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">{badge}</div>
    </article>
  );
}

const OPEN_STATUSES = ["draft", "pending_approval", "approved", "blocked", "failed"];

/** Where a review stands: the open draft's state if there is one, else whether Google has a reply. */
function ReplyState({
  data,
  googleReply,
  googleReplyState,
  compact = false,
}: {
  data: ReplyData | undefined;
  googleReply: boolean;
  /** Google's moderation of the existing reply: REJECTED replies are kept but hidden from customers. */
  googleReplyState: string | null;
  /** The list row has no room for the long rejected label; the detail shows it in full. */
  compact?: boolean;
}) {
  const t = useTranslations("reviews");
  const open = data?.revisions.find((r) => OPEN_STATUSES.includes(r.status))?.status;
  if (open) return <StatusBadge status={open} label={t(`openState.${open}`)} />;
  if (googleReply && googleReplyState === "REJECTED") {
    return (
      <StatusBadge
        status="rejected"
        label={compact ? t("replyState.rejectedShort") : t("replyState.rejectedLong")}
      />
    );
  }
  return googleReply ? (
    <StatusBadge status="published" label={t("replyState.replied")} />
  ) : (
    <StatusBadge status="pending" label={t("replyState.needsReply")} />
  );
}

const EMPTY_REPLY_DATA: ReplyData = {
  revisions: [],
  review: {
    hasGoogleReply: false,
    openRevisionId: null,
    canDraft: false,
    canDeletePublished: false,
  },
};

const QUEUE_STATUSES = ["pending_approval", "blocked", "failed", "approved", "conflict"] as const;
type QueueStatus = (typeof QUEUE_STATUSES)[number];

async function OtherReplyStates({
  status,
  ws,
  urlWs,
  canDraft,
}: {
  status: QueueStatus;
  ws?: string;
  urlWs?: string;
  canDraft: boolean;
}) {
  const t = await getTranslations("reviews");
  const result = await reviewReplies_listQueue({ status, workspaceId: ws, limit: 25 });
  if (!result.ok) return <ErrorText message={`${result.error.code}: ${result.error.message}`} />;
  const { items } = result.data as Handler<typeof reviewRepliesListQueue>;
  const templates = await loadTemplates(items.map((i) => i.review.workspaceId));
  return (
    <section aria-label={t("queue.otherStates")} className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t.rich("queue.waiting", {
          link: (chunks) => (
            <Link href={approvalsHref({ tab: "reply", ws: urlWs })} className="underline">
              {chunks}
            </Link>
          ),
        })}
      </p>
      <PillLinks
        label={t("queue.statusNav")}
        items={QUEUE_STATUSES.filter((st) => st !== "pending_approval").map((st) => ({
          href: `/reviews?view=queue&qstatus=${st}${urlWs ? `&ws=${encodeURIComponent(urlWs)}` : ""}`,
          label: t(`queue.status.${st}`),
          current: st === status,
        }))}
      />
      {items.length === 0 && (
        <EmptyState title={t(`queue.empty.${status}`)}>
          {t("queue.emptyBody")}
        </EmptyState>
      )}
      <ul className="flex flex-col gap-3">
        {items.map(({ reply, review }) => (
          <ReviewCard
            key={reply.id}
            rating={review.rating}
            reviewer={review.reviewerDisplayName ?? t("unknown")}
            meta={`${review.workspaceName} · ${review.locationName}`}
            comment={review.comment}
            badges={<StatusBadge status={reply.status} />}
          >
            <ReplyPanel
              reviewId={review.id}
              googleReply={review.googleReply}
              templates={templates.get(review.workspaceId)}
              initial={{
                revisions: [reply],
                review: {
                  hasGoogleReply: review.googleReply !== null,
                  openRevisionId: reply.id,
                  // a conflicted reply is resolved by a new revision (needs review:draft)
                  canDraft: reply.status === "conflict" && canDraft,
                  canDeletePublished: false,
                },
              }}
            />
          </ReviewCard>
        ))}
      </ul>
    </section>
  );
}

/** The chosen due day: a due date is stored as the start of the next day in the client's zone. */
const dueDayOf = (dueAt: string | null, zone: string) =>
  dueAt ? dayKey(new Date(new Date(dueAt).getTime() - 1), zone) : "";

function AssignedLine({
  item,
  userId,
}: {
  item: Handler<typeof reviewsAssignments>["items"][number] | undefined;
  userId: string;
}) {
  const t = useTranslations("reviews");
  const a = item?.assignment;
  if (!a && !item?.noteCount) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {a && (
        <span>{a.assigneeUserId === userId ? t("assigned.toYou") : t("assigned.to", { name: a.assigneeName })}</span>
      )}
      {a?.overdue && <span className="font-semibold text-bad">{t("assigned.overdue")}</span>}
      {item!.noteCount > 0 && (
        <span>{t("assigned.notes", { count: item!.noteCount })}</span>
      )}
    </span>
  );
}

const reviewerName = (r: ReviewItem, t: (key: string) => string) =>
  r.reviewer.isAnonymous ? t("anonymous") : (r.reviewer.displayName ?? t("unknown"));
const metaOf = (r: ReviewItem, tf: TimeFormat, ws?: string) => `${r.location.name} · ${tf.date(r.createTime, ws)}`;

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const t = await getTranslations("reviews");
  const tt = await getTranslations("reviewTopics");
  const { userId } = await requireUser();
  const { role } = await actorContextFor(userId);
  const canSync = roleHasPermission(role, "review:draft");
  const sp = await searchParams;
  const view = parseView(sp.view, { canDraft: canSync });
  const qstatus = (QUEUE_STATUSES as readonly string[]).includes(sp.qstatus ?? "")
    ? (sp.qstatus as QueueStatus)
    : "pending_approval";
  // Core decides who has an approval queue: a FORBIDDEN here hides the tab.
  const queueProbe = await reviewReplies_listQueue({ status: "pending_approval", limit: 1 });
  const hasQueue = queueProbe.ok;
  const scope = await currentScope(sp.ws);
  const ws = scope.workspaceId ?? undefined;
  // The old Approval queue tab: /approvals is the one queue, with Replies preselected. Replies in
  // other states (blocked, failed, approved, conflict) are not approvals and stay here.
  if (view === "queue" && hasQueue) {
    const to = queueRedirect("reviews", { ws: scope.urlWs, qstatus: sp.qstatus });
    if (to) redirect(to);
  }
  const counts = hasQueue ? await approvals_counts(ws ? { workspaceId: ws } : {}) : null;
  const queueTab = counts?.ok
    ? approvalSurfaces(counts.data as Handler<typeof approvalsCounts>, scope.urlWs).reviewsTab
    : undefined;
  const tf = await getTimeFormat(scope.urlWs);

  if (view === "bulk") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader
          title={t("title")}
          description={t("descriptionBulk")}
        />
        <ReviewsTabs current="bulk" hasQueue={hasQueue} canDraft={canSync} ws={scope.urlWs} queueTab={queueTab} />
        <BulkReplyView
          workspaceId={scope.onlyWorkspaceId}
          urlWs={scope.urlWs}
          scopeLocationIds={scope.locationIds}
          narrow={scope.kind === "group" || scope.kind === "location"}
          sp={{
            loc: first(sp.loc),
            rating: first(Array.isArray(sp.rating) ? sp.rating[0] : sp.rating),
          }}
        />
      </div>
    );
  }

  const [wsResult, locResult] = await Promise.all([
    workspaces_list(),
    locations_list({ status: "active" }),
  ]);
  if (!wsResult.ok || !locResult.ok) {
    const e = !wsResult.ok ? wsResult.error : !locResult.ok ? locResult.error : null;
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("title")} />
        <ErrorText message={e ? `${e.code}: ${e.message}` : null} />
      </div>
    );
  }
  const workspaces = (wsResult.data as Handler<typeof workspacesList>).workspaces;
  const allLocations = (locResult.data as Handler<typeof locationsList>).locations;

  const loc = first(sp.loc);
  const group = first(sp.group);
  const ratings = (Array.isArray(sp.rating) ? sp.rating : sp.rating ? [sp.rating] : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  const replied = sp.replied === "yes" ? true : sp.replied === "no" ? false : undefined;
  const from = first(sp.from);
  const to = first(sp.to);
  const q = parseQuery(sp.q);
  const sort = parseSort(sp.sort);
  const topic = parseTopic(sp.topic);
  const sentiment = parseSentiment(sp.sentiment);

  const locationOptions = allLocations.filter((l) => scope.locationIds.includes(l.id));
  const groupOptions = [
    ...new Map(
      locationOptions.flatMap((l) => l.groups.map((g) => [g.id, g.name] as const)),
    ).entries(),
  ];

  const assign = canSync && (sp.assign === "me" || sp.assign === "overdue") ? sp.assign : undefined;
  const result = view !== "inbox" ? null : await reviews_list({
    ...(assign === "me" ? { assignedToMe: true } : {}),
    ...(assign === "overdue" ? { overdue: true } : {}),
    ...scopeFilter(scope),
    ...(loc ? { locationIds: [loc] } : {}),
    ...(group ? { groupId: group } : {}),
    ratings: ratings.length ? ratings : undefined,
    replied,
    q,
    topic,
    sentiment,
    sort,
    ...dayRange(tf.zone(), from, to),
    cursor: first(sp.cursor),
    limit: 25,
  });
  const data = result?.ok ? (result.data as Handler<typeof reviewsList>) : null;
  const rows = data?.items ?? [];

  // ?review=<id> (also the negative-review alert link) selects a review for the right pane; the
  // list stays as filtered. A review that is not on this page is fetched; core decides whether the
  // caller may see it, and an unreadable id selects nothing.
  const reviewId = first(sp.review);
  const wanted = view === "inbox" && reviewId && UUID.test(reviewId) ? reviewId : undefined;
  const fromList = wanted ? (rows.find((r) => r.id === wanted) ?? null) : null;
  let fetched: ReviewItem | null = null;
  if (wanted && !fromList) {
    const one = await reviews_get({ id: wanted });
    if (one.ok) fetched = (one.data as Handler<typeof reviewsGet>).review;
  }
  const selected: ReviewItem | null = fromList ?? fetched;

  // One list call per review on the page (plus the selected one); core says what the caller may do with each.
  const replyData = new Map<string, ReplyData>();
  if (view === "inbox") {
    const ids = new Set([...rows.map((r) => r.id), ...(selected ? [selected.id] : [])]);
    await Promise.all(
      [...ids].map(async (id) => {
        const rr = await reviewReplies_list({ reviewId: id });
        if (rr.ok) replyData.set(id, rr.data as Handler<typeof reviewRepliesList>);
      }),
    );
  }

  const workspaceIdOf = (locationId: string) => allLocations.find((l) => l.id === locationId)?.workspaceId ?? "";
  // Team-only: assignments for the visible reviews, and the selected review's assignees and notes.
  // Core refuses these to client roles, so canSync (review:draft) only decides whether to ask.
  const assignmentById = new Map<string, Handler<typeof reviewsAssignments>["items"][number]>();
  let assignees: Handler<typeof reviewsAssignees>["assignees"] = [];
  let notes: Handler<typeof reviewNotesList>["notes"] = [];
  if (view === "inbox" && canSync) {
    const ids = [...new Set([...rows.map((r) => r.id), ...(selected ? [selected.id] : [])])];
    const [asg, people, thread] = await Promise.all([
      ids.length ? reviews_assignments({ reviewIds: ids.slice(0, 100) }) : null,
      selected ? reviews_assignees({ workspaceId: workspaceIdOf(selected.location.id) }) : null,
      selected ? reviewNotes_list({ reviewId: selected.id }) : null,
    ]);
    if (asg?.ok)
      for (const i of (asg.data as Handler<typeof reviewsAssignments>).items) assignmentById.set(i.reviewId, i);
    if (people?.ok) assignees = (people.data as Handler<typeof reviewsAssignees>).assignees;
    if (thread?.ok) notes = (thread.data as Handler<typeof reviewNotesList>).notes;
  }

  const workspaceByLocation = new Map(allLocations.map((l) => [l.id, l.workspaceId]));
  const shown = selected && !rows.some((r) => r.id === selected.id) ? [...rows, selected] : rows;
  const templates =
    view === "inbox"
      ? await loadTemplates(shown.flatMap((r) => workspaceByLocation.get(r.location.id) ?? []))
      : new Map<string, TemplateOption[]>();

  const nextParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "cursor" || v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) nextParams.append(k, x);
  }
  if (data?.nextCursor) nextParams.set("cursor", data.nextCursor);

  const filtersActive = Boolean(
    loc || group || ratings.length || replied !== undefined || from || to || q || assign || topic || sentiment,
  );
  /** This page's URL with one query param replaced (or removed when empty), cursor dropped. */
  const withParam = (key: string, value: string | undefined) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "cursor" || k === key || v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
    }
    if (value) p.set(key, value);
    const qs = p.toString();
    return qs ? `/reviews?${qs}` : "/reviews";
  };
  /** The URL that selects one review (or none), keeping the filters and the page of the list. */
  const withReview = (id: string | undefined) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "review" || v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
    }
    if (id) p.set("review", id);
    const qs = p.toString();
    return qs ? `/reviews?${qs}` : "/reviews";
  };

  /** The current filters as a CSV download (core caps the rows and audits the export). */
  const exportParams = new URLSearchParams();
  // The export route reads ws, loc and group from its URL; the scope is not in the page URL, so write it in.
  const sf = scopeFilter(scope);
  if (ws) exportParams.set("ws", ws);
  const exportLoc = loc ?? sf.locationIds?.[0];
  const exportGroup = group ?? sf.groupId;
  if (exportLoc) exportParams.set("loc", exportLoc);
  if (exportGroup) exportParams.set("group", exportGroup);
  for (const k of ["replied", "from", "to"] as const) {
    const v = first(sp[k]);
    if (v) exportParams.set(k, v);
  }
  if (q) exportParams.set("q", q);
  if (topic) exportParams.set("topic", topic);
  if (sentiment) exportParams.set("sentiment", sentiment);
  if (sort) exportParams.set("sort", sort);
  for (const n of ratings) exportParams.append("rating", String(n));

  const field = filterFieldClass;
  // A selected review shows even when the list failed to load.
  const showPane = selected !== null || (data !== null && rows.length > 0);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <AutoApproveChip workspaceIds={autoApproveIds(scope, workspaces)} />
            {view === "inbox" && canSync
              ? workspaces.filter((w) => !ws || w.id === ws).map((w) => (
                  <SyncNow key={w.id} workspaceId={w.id} workspaceName={w.name} />
                ))
              : null}
          </>
        }
      />
      <ReviewsTabs current={view} hasQueue={hasQueue} canDraft={canSync} ws={scope.urlWs} queueTab={queueTab} />

      {view === "queue" && hasQueue && (
        <>
          {narrowNote(scope, "The approval queue") && (
            <p className="text-xs text-muted-foreground">{narrowNote(scope, "The approval queue")}</p>
          )}
          <OtherReplyStates status={qstatus} ws={ws} urlWs={scope.urlWs} canDraft={canSync} />
        </>
      )}
      {view === "queue" && !hasQueue && (
        <EmptyState title={t("queue.noQueueTitle")}>
          {t("queue.noQueueBody")}
        </EmptyState>
      )}

      {view === "analytics" && (
        <AnalyticsView
          sp={{ ws, loc: loc ?? sf.locationIds?.[0], group: group ?? sf.groupId, period: sp.period, from: sp.from, to: sp.to }}
          workspaces={workspaces}
          locations={allLocations.map((l) => ({ id: l.id, name: l.name, workspaceId: l.workspaceId }))}
          canClassify={canSync}
          canConfigure={roleHasPermission(role, "review:configure")}
        />
      )}

      {view === "requests" && !scope.onlyWorkspaceId && (
        <ChooseClient
          title={t("requests.pickClientTitle")}
          text={t("requests.pickClientText")}
          path="/reviews?view=requests"
          workspaces={workspaces}
        />
      )}
      {view === "requests" && scope.onlyWorkspaceId && (
        <RequestsView
          sp={{ ws: scope.onlyWorkspaceId, loc }}
          locations={locationOptions.map((l) => ({ id: l.id, name: l.name, workspaceId: l.workspaceId }))}
          origin={process.env.BETTER_AUTH_URL || "http://localhost:3000"}
          canManage={canSync}
        />
      )}

      {view === "inbox" && (
        <>
          <form method="get" aria-label={t("filters.form")} className="flex flex-wrap items-center gap-2">
            {scope.urlWs && <input type="hidden" name="ws" value={scope.urlWs} />}
            {replied !== undefined && <input type="hidden" name="replied" value={replied ? "yes" : "no"} />}
            {assign && <input type="hidden" name="assign" value={assign} />}
            <input
              type="search"
              name="q"
              aria-label={t("filters.searchLabel")}
              placeholder={t("filters.searchPlaceholder")}
              maxLength={100}
              defaultValue={q ?? ""}
              className={`${field} w-full sm:w-64`}
            />
            {scope.kind !== "location" && (
              <select name="loc" aria-label={t("filters.location")} defaultValue={loc ?? ""} className={field}>
                <option value="">{t("filters.allLocations")}</option>
                {locationOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            {scope.kind !== "group" && scope.kind !== "location" && (
              <select name="group" aria-label={t("filters.group")} defaultValue={group ?? ""} className={field}>
                <option value="">{t("filters.allGroups")}</option>
                {groupOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">{t("filters.rating")}</legend>
              {[1, 2, 3, 4, 5].map((n) => (
                <label key={n} className="cursor-pointer">
                  <input
                    type="checkbox"
                    name="rating"
                    value={n}
                    defaultChecked={ratings.includes(n)}
                    className="peer sr-only"
                  />
                  <span className="inline-flex min-h-(--control-h) min-w-10 items-center justify-center rounded-control border border-input bg-card px-2 text-[13px] font-semibold peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:outline-2 peer-focus-visible:outline-ring">
                    {n}★
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              {t("filters.from")}
              <input type="date" name="from" defaultValue={from ?? ""} className={field} />
            </label>
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              {t("filters.toInclusive")}
              <input type="date" name="to" defaultValue={to ?? ""} className={field} />
            </label>
            <select name="topic" aria-label={tt("filters.topic")} defaultValue={topic ?? ""} className={field}>
              <option value="">{tt("filters.allTopics")}</option>
              {REVIEW_TOPIC_IDS.map((id) => (
                <option key={id} value={id}>
                  {tt(`topic.${id}`)}
                </option>
              ))}
            </select>
            <select name="sentiment" aria-label={tt("filters.sentiment")} defaultValue={sentiment ?? ""} className={field}>
              <option value="">{tt("filters.anySentiment")}</option>
              {TOPIC_SENTIMENTS.map((s) => (
                <option key={s} value={s}>
                  {tt(`sentiment.${s}`)}
                </option>
              ))}
            </select>
            <select name="sort" aria-label={t("filters.sortBy")} defaultValue={sort ?? "newest"} className={field}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(`sort.${o.value}`)}
                </option>
              ))}
            </select>
            <button type="submit" className={secondaryButtonClass}>
              {t("filters.filter")}
            </button>
            {filtersActive && (
              <Link href="/reviews" className="text-sm underline">
                {t("filters.clear")}
              </Link>
            )}
          </form>

          <PillLinks
            label={t("filters.replyNav")}
            items={[
              {
                href: withParam("replied", undefined),
                label: t("filters.all"),
                current: replied === undefined,
              },
              {
                href: withParam("replied", "no"),
                label: t("replyState.needsReply"),
                current: replied === false,
              },
              { href: withParam("replied", "yes"), label: t("replyState.replied"), current: replied === true },
            ]}
          />

          {canSync && (
            <PillLinks
              label={t("assigned.navLabel")}
              items={[
                { href: withParam("assign", undefined), label: t("assigned.everyone"), current: assign === undefined },
                { href: withParam("assign", "me"), label: t("assigned.toMe"), current: assign === "me" },
                { href: withParam("assign", "overdue"), label: t("assigned.overdue"), current: assign === "overdue" },
              ]}
            />
          )}

          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {data && (
              <strong>{t("list.showing", { count: rows.length })}</strong>
            )}
            {data?.nextCursor && <span className="text-muted-foreground">{t("list.olderBelow")}</span>}
            <span className="ml-auto">
              <ExportDialog
                filters={[...exportParams.entries()]}
                workspaceLabel={ws ? (workspaces.find((w) => w.id === ws)?.name ?? null) : null}
                maxRows={REVIEWS_CONFIG.exportMaxRows}
              />
            </span>
          </div>

          {result && !result.ok && <ErrorText message={`${result.error.code}: ${result.error.message}`} />}
          {data && rows.length === 0 && !selected && filtersActive && (
            <EmptyState
              title={t("list.noMatchTitle")}
              action={
                <Link href="/reviews" className={linkButtonClass}>
                  {t("list.clearFilters")}
                </Link>
              }
            >
              {t("list.noMatchBody")}
            </EmptyState>
          )}
          {data && rows.length === 0 && !selected && !filtersActive && allLocations.length === 0 && (
            <EmptyState
              title={t("list.noLocationsTitle")}
              action={
                <Link href="/locations" className={linkButtonClass}>
                  {t("list.importLocations")}
                </Link>
              }
            >
              {t("list.noLocationsBody")}
            </EmptyState>
          )}
          {data && rows.length === 0 && !selected && !filtersActive && allLocations.length > 0 && (
            <EmptyNext id="reviews" />
          )}

          {showPane && (
            <div className="flex flex-col overflow-hidden rounded-panel border border-border bg-card shadow-card lg:flex-row">
              <section
                aria-label={t("list.reviewList")}
                className={`min-w-0 flex-col border-b border-border bg-card lg:w-[400px] lg:shrink-0 lg:border-b-0 lg:border-r ${
                  selected ? "hidden lg:flex" : "flex"
                }`}
              >
                <ul>
                  {rows.map((r) => (
                    <ReviewRow
                      key={r.id}
                      rating={r.rating}
                      reviewer={reviewerName(r, t)}
                      meta={metaOf(r, tf, workspaceByLocation.get(r.location.id))}
                      comment={r.comment}
                      selected={r.id === selected?.id}
                      href={withReview(r.id)}
                      assigned={
                        canSync ? <AssignedLine item={assignmentById.get(r.id)} userId={userId} /> : null
                      }
                      badge={
                        <ReplyState
                          compact
                          data={replyData.get(r.id)}
                          googleReply={r.reply !== null}
                          googleReplyState={r.reply?.state ?? null}
                        />
                      }
                    />
                  ))}
                </ul>
                {data?.nextCursor && (
                  <Link
                    href={`/reviews?${nextParams.toString()}`}
                    className="px-3.5 py-3 text-[13px] font-bold text-brand-text underline underline-offset-2"
                  >
                    {t("list.olderReviews")}
                  </Link>
                )}
              </section>

              <section
                aria-label={t("list.selectedReview")}
                className={`min-w-0 flex-1 flex-col gap-4 p-5 lg:p-6 ${
                  selected ? "flex" : "hidden lg:flex"
                }`}
              >
                {selected ? (
                  <>
                    <Link
                      href={withReview(undefined)}
                      className="text-sm font-semibold text-brand-text underline underline-offset-2 lg:hidden"
                    >
                      {t("list.allReviews")}
                    </Link>
                    <ReviewDetail
                      rating={selected.rating}
                      reviewer={reviewerName(selected, t)}
                      meta={metaOf(selected, tf, workspaceByLocation.get(selected.location.id))}
                      comment={selected.comment}
                      badge={
                        <ReplyState
                          data={replyData.get(selected.id)}
                          googleReply={selected.reply !== null}
                          googleReplyState={selected.reply?.state ?? null}
                        />
                      }
                    />
                    {canSync && (
                      <AssignPanel
                        key={`assign-${selected.id}`}
                        reviewId={selected.id}
                        zone={tf.zone(workspaceByLocation.get(selected.location.id))}
                        assignees={assignees.map((a) => ({ userId: a.userId, name: a.name }))}
                        initialAssigneeId={assignmentById.get(selected.id)?.assignment?.assigneeUserId ?? ""}
                        initialDueDay={dueDayOf(
                          assignmentById.get(selected.id)?.assignment?.dueAt ?? null,
                          tf.zone(workspaceByLocation.get(selected.location.id)),
                        )}
                        initialNotes={notes}
                        timeText={Object.fromEntries(
                          notes.map((n) => [n.id, tf.dateTime(n.createdAt, workspaceByLocation.get(selected.location.id))]),
                        )}
                      />
                    )}
                    <ReplyPanel
                      key={selected.id}
                      reviewId={selected.id}
                      googleReply={selected.reply?.comment ?? null}
                      templates={templates.get(workspaceByLocation.get(selected.location.id) ?? "")}
                      initial={replyData.get(selected.id) ?? EMPTY_REPLY_DATA}
                    />
                  </>
                ) : (
                  <div className="m-auto flex flex-col items-center gap-1 py-16 text-center">
                    <p className="font-display font-bold">{t("list.pickTitle")}</p>
                    <p className="max-w-xs text-sm text-muted-foreground">
                      {t("list.pickBody")}
                    </p>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
