import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type {
  brandingLogos,
  locationsList,
  postImagesList,
  postsGet,
  postTemplatesGet,
  postTemplatesList,
  workspacesList,
} from "@opengmb/core";
import {
  BULK_COLUMNS,
  BULK_POST_LIMITS,
  BULK_VARIABLES,
  bulkTemplateCsv,
  MEDIA_LIMITS,
  POST_LANGUAGES,
  POST_LIMITS,
  roleHasPermission,
  integrationEnv,
} from "@opengmb/core";
import { BulkImport } from "../../../components/posts/bulk-import";
import { CalendarView } from "../../../components/posts/calendar-view";
import { GoogleView } from "../../../components/posts/google-view";
import { ListView } from "../../../components/posts/list-view";
import { MediaLibrary } from "../../../components/posts/media-library";
import { TemplatesView } from "../../../components/posts/templates-view";
import { PostComposer } from "../../../components/post-composer";
import { ChooseClient } from "../../../components/choose-client";
import { EmptyState, ErrorText, PageHeader } from "../../../components/ui";
import { linkButtonClass, PillLinks, primaryLinkButtonClass, TabLinks } from "../../../components/page-parts";
import { queueRedirect } from "../../../lib/approval-surfaces";
import { actorContextFor } from "../../../lib/auth";
import { requireUser } from "../../../lib/guard";
import { liveStatus } from "../../../lib/live-status";
import {
  legacyPostView,
  parseLibrarySection,
  parsePostView,
  postViewTabs,
  postsHref,
  type ComposeForm,
} from "../../../lib/posts";
import { prefillFromTemplate } from "../../../lib/post-templates";
import { narrowArgs, narrowLocationIds } from "../../../lib/scope-pages";
import { currentScope } from "../../../lib/scope-server";
import {
  branding_logos,
  locations_list,
  postImages_list,
  postTemplates_get,
  postTemplates_list,
  posts_get,
  workspaces_list,
} from "../../_generated/actions";

type Handler<T extends { handler: (...a: never[]) => unknown }> = Awaited<ReturnType<T["handler"]>>;

type Search = {
  view?: string;
  ws?: string;
  status?: string;
  section?: string;
  type?: string;
  q?: string;
  month?: string;
  post?: string;
  edit?: string;
  loc?: string;
  template?: string;
  image?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Views that work in exactly one client; with several and the scope on All clients they ask for one. */
const ONE_CLIENT_VIEWS = new Set<string>(["compose", "import", "google", "library"]);

const errorOf = (e: { code: string; message: string }) => `${e.code}: ${e.message}`;

export default async function PostsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { userId } = await requireUser();
  const t = await getTranslations("posts");
  const { role } = await actorContextFor(userId);
  const canDraft = roleHasPermission(role, "review:draft");
  const sp = await searchParams;
  const view = parsePostView(sp.view);
  const section = parseLibrarySection(sp.section);

  const wsResult = await workspaces_list();
  if (!wsResult.ok) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("page.title")} />
        <ErrorText message={errorOf(wsResult.error)} />
      </div>
    );
  }
  const workspaces = (wsResult.data as Handler<typeof workspacesList>).workspaces;

  // ?edit=<id> opens that post in its own workspace, whatever ?ws= says.
  let editPost: Handler<typeof postsGet>["post"] | undefined;
  if (view === "compose" && canDraft && sp.edit && UUID.test(sp.edit)) {
    const r = await posts_get({ id: sp.edit });
    if (r.ok) {
      const p = (r.data as Handler<typeof postsGet>).post;
      if (p.can.edit) editPost = p;
    }
  }
  const scope = await currentScope(sp.ws);
  // The old Approval queue tab: /approvals is the one queue, with Posts preselected.
  if (sp.view === "queue") redirect(queueRedirect("posts", { ws: scope.urlWs }) ?? "/approvals");
  // The old Media library and Templates tabs are the Library tab's two sections.
  const moved = legacyPostView(sp.view);
  if (moved) redirect(postsHref(moved.view, scope.urlWs, moved.section));
  // All posts can span clients; the other views work in one (the scope's, or the only one).
  const oneClient = ONE_CLIENT_VIEWS.has(view);
  const ws = oneClient ? (editPost?.workspaceId ?? scope.onlyWorkspaceId ?? undefined) : (scope.workspaceId ?? undefined);
  const carry = scope.urlWs; // a ?ws= deep link survives tab and view links
  // A group or location scope narrows lists and pickers to its locations.
  const narrowIds = narrowLocationIds(scope);
  const current = workspaces.find((w) => w.id === ws);
  const writesOff =
    liveStatus(integrationEnv(), false).rows.find((r) => r.key === "writes")?.state === "off";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("page.title")}
        description={t("page.description")}
        actions={
          view !== "compose" && canDraft ? (
            <div className="flex flex-wrap gap-2">
              {view !== "import" && (
                <Link href={postsHref("import", carry)} className={linkButtonClass}>
                  {t("page.importPosts")}
                </Link>
              )}
              <Link href={postsHref("compose", carry)} className={primaryLinkButtonClass}>
                {t("page.newPost")}
              </Link>
            </div>
          ) : undefined
        }
      />
      <TabLinks
        label={t("page.views")}
        items={postViewTabs(t, view, { ws: carry })}
      />

      {workspaces.length === 0 && (
        <EmptyState
          title={t("page.noClientTitle")}
          action={
            <Link href="/workspaces" className={primaryLinkButtonClass}>
              {t("page.createClient")}
            </Link>
          }
        >
          {t("page.noClientBody")}
        </EmptyState>
      )}
      {!ws && workspaces.length > 0 && oneClient && (
        <ChooseClient
          title={t("page.chooseTitle")}
          text={t("page.chooseText")}
          path={`/posts?view=${view}`}
          workspaces={workspaces}
        />
      )}
      {view === "compose" && current && (
        <Compose
          ws={current.id}
          scopeLocationIds={narrowIds}
          workspaceName={current.name}
          defaultLanguage={current.defaultPostLanguage}
          canDraft={canDraft}
          post={editPost}
          template={sp.template}
          image={sp.image}
        />
      )}
      {view === "import" && current && (
        <ImportPosts ws={current.id} workspaceName={current.name} canDraft={canDraft} />
      )}
      {view === "list" && (
        <ListView
          ws={ws}
          carry={carry}
          scopeLocationIds={narrowIds}
          scopeName={current?.name ?? t("page.allClients")}
          status={sp.status}
          type={sp.type}
          q={sp.q}
          post={sp.post}
          writesOff={writesOff}
        />
      )}
      {view === "calendar" && <CalendarView ws={ws} carry={carry} narrow={narrowArgs(scope)} month={sp.month} />}
      {view === "google" && ws && <GoogleView ws={ws} carry={carry} scopeLocationIds={narrowIds} loc={sp.loc} />}
      {view === "library" && ws && current && (
        <>
          <PillLinks
            label={t("page.librarySections")}
            items={[
              { href: postsHref("library", carry, "media"), label: t("page.media"), current: section === "media" },
              { href: postsHref("library", carry, "templates"), label: t("page.templates"), current: section === "templates" },
            ]}
          />
          {section === "templates" ? (
            <Templates
              ws={ws}
              workspaceName={current.name}
              defaultLanguage={current.defaultPostLanguage}
              canConfigure={roleHasPermission(role, "review:configure")}
            />
          ) : (
            <Media ws={ws} workspaceName={current.name} />
          )}
        </>
      )}
    </div>
  );
}

async function ImportPosts({ ws, workspaceName, canDraft }: { ws: string; workspaceName: string; canDraft: boolean }) {
  if (!canDraft) {
    const t = await getTranslations("posts");
    return (
      <EmptyState title={t("page.readTitle")}>
        {t("page.importNeedsRole")}
      </EmptyState>
    );
  }
  return (
    <BulkImport
      workspaceId={ws}
      workspaceName={workspaceName}
      maxRows={BULK_POST_LIMITS.maxRows}
      variables={[...BULK_VARIABLES]}
      columns={BULK_COLUMNS.map((c) => ({ name: c.names[0], required: c.required, help: c.help }))}
      template={bulkTemplateCsv(new Date())}
    />
  );
}

async function Media({ ws, workspaceName }: { ws: string; workspaceName: string }) {
  const r = await postImages_list({ workspaceId: ws });
  if (!r.ok) return <ErrorText message={errorOf(r.error)} />;
  const d = r.data as Handler<typeof postImagesList>;
  // Only whether this client has an uploaded logo; the picture itself is drawn on the server.
  const logos = await branding_logos({});
  const hasLogo = logos.ok && (logos.data as Handler<typeof brandingLogos>).workspaceLogos.some((l) => l.workspaceId === ws);
  return (
    <MediaLibrary
      workspaceId={ws}
      workspaceName={workspaceName}
      images={d.images}
      canManage={d.can.manage}
      maxBytes={MEDIA_LIMITS.photo.maxBytes}
      hasLogo={hasLogo}
    />
  );
}

async function Templates({
  ws,
  workspaceName,
  defaultLanguage,
  canConfigure,
}: {
  ws: string;
  workspaceName: string;
  defaultLanguage: string;
  canConfigure: boolean;
}) {
  const t = await postTemplates_list({ workspaceId: ws });
  if (!t.ok) return <ErrorText message={errorOf(t.error)} />;
  const list = t.data as Handler<typeof postTemplatesList>;
  return (
    <TemplatesView
      workspaceId={ws}
      workspaceName={workspaceName}
      templates={list.templates}
      canManage={list.can.manage}
      languages={POST_LANGUAGES.map((l) => ({ code: l.code, label: l.label }))}
      defaultLanguage={defaultLanguage}
      canConfigure={canConfigure}
      maxBytes={MEDIA_LIMITS.photo.maxBytes}
    />
  );
}

async function Compose({
  ws,
  scopeLocationIds,
  workspaceName,
  defaultLanguage,
  canDraft,
  post,
  template,
  image,
}: {
  ws: string;
  /** Set for a group or location scope: only these locations are offered. */
  scopeLocationIds?: string[];
  workspaceName: string;
  defaultLanguage: Handler<typeof workspacesList>["workspaces"][number]["defaultPostLanguage"];
  canDraft: boolean;
  post?: Handler<typeof postsGet>["post"];
  template?: string;
  image?: string;
}) {
  const tp = await getTranslations("posts");
  if (!canDraft) {
    return (
      <EmptyState
        title={tp("page.readTitle")}
        action={
          <Link href={postsHref("list", ws)} className={linkButtonClass}>
            {tp("page.openAllPosts")}
          </Link>
        }
      >
        {tp("page.composeNeedsRole")}
      </EmptyState>
    );
  }
  const locResult = await locations_list({ workspaceId: ws, status: "active" });
  if (!locResult.ok) return <ErrorText message={errorOf(locResult.error)} />;
  const locations = (locResult.data as Handler<typeof locationsList>).locations
    .filter((l) => !scopeLocationIds || post || scopeLocationIds.includes(l.id))
    .map((l) => ({
      id: l.id,
      title: l.title ?? l.name,
      addressSummary: l.addressSummary,
      phone: l.phone,
    }));
  if (locations.length === 0 && !post) {
    return (
      <EmptyState
        title={tp("page.noActiveTitle")}
        action={
          <Link href="/locations" className={linkButtonClass}>
            {tp("page.openLocations")}
          </Link>
        }
      >
        {tp("page.noActiveBody")}
      </EmptyState>
    );
  }
  let prefill: Partial<ComposeForm> | undefined;
  let startedFrom: string | null = null;
  if (!post && template && UUID.test(template)) {
    const r = await postTemplates_get({ id: template });
    if (r.ok) {
      const t = (r.data as Handler<typeof postTemplatesGet>).template;
      if (t.workspaceId === ws) {
        const { image: url, language, ...rest } = prefillFromTemplate(t);
        prefill = {
          ...rest,
          language: language as ComposeForm["language"],
          image: url ? { sourceUrl: url } : null,
        };
        startedFrom = tp("page.startedTemplate");
      }
    }
  } else if (!post && image && UUID.test(image)) {
    const r = await postImages_list({ workspaceId: ws });
    const img = r.ok
      ? (r.data as Handler<typeof postImagesList>).images.find((i) => i.id === image)
      : undefined;
    if (img) {
      prefill = { image: { sourceUrl: img.url } };
      startedFrom = tp("page.startedImage", { name: img.name });
    }
  }
  return (
    <>
      {startedFrom && <p className="text-sm text-muted-foreground">{startedFrom}</p>}
      <PostComposer
        key={post?.id ?? `new-${template ?? image ?? ""}`}
        workspaceId={ws}
        workspaceName={workspaceName}
        locations={locations}
        languages={POST_LANGUAGES}
        defaultLanguage={defaultLanguage}
        maxChars={POST_LIMITS.summaryMaxChars.limit}
        maxImageBytes={MEDIA_LIMITS.photo.maxBytes}
        prefill={prefill}
        post={post}
      />
    </>
  );
}
