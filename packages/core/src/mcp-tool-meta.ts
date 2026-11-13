import { PRIVATE_TITLE_OVERRIDES, PRIVATE_DESTRUCTIVE_ACTIONS, PRIVATE_DIRECTORY_EXCLUDED, PRIVATE_NON_DESTRUCTIVE_ACTIONS } from "./mcp-tool-meta-private";
import type { AnyAction } from "./registry";

/** Words shown in a fixed form in tool titles. */
const WORDS: Record<string, string> = { ai: "AI", mcp: "MCP", api: "API", csv: "CSV", hipaa: "HIPAA", url: "URL", geogrid: "Geo-grid", byo: "own" };

/** Titles the name-derived rule gets wrong. Keep short; the test prints any duplicates. */
export const TITLE_OVERRIDES: Readonly<Record<string, string>> = {
  ...PRIVATE_TITLE_OVERRIDES,
  "geogrid.byoKey.set": "Geo-grid: set own API key",
  "geogrid.byoKey.get": "Geo-grid: get own API key",
  "geogrid.byoKey.delete": "Geo-grid: delete own API key",
  "geogrid.byoKey.verify": "Geo-grid: verify own API key",
  "geogrid.competitors.changes": "Geo-grid: competitor changes",
  "geogrid.competitors.profiles": "Geo-grid: competitor profiles",
  "geogrid.configs.create": "Geo-grid: create config",
  "geogrid.configs.update": "Geo-grid: update config",
  "geogrid.configs.delete": "Geo-grid: delete config",
  "geogrid.quickScans.create": "Geo-grid: create quick scan",
  "onboarding.firstDraft": "Onboarding: free first reply draft",
  "geogrid.runs.get": "Geo-grid: get run",
  "reports.definitions.create": "Reports: create report",
  "reports.definitions.update": "Reports: update report",
  "reports.definitions.delete": "Reports: delete report",
  "reports.runs.get": "Reports: get run",
  "profile.changeSets.get": "Profile: get change set",
  "profile.categories.suggestions": "Profile: category suggestions",
  "profile.attributes.metadata": "Profile: attribute metadata",
  "media.customer.list": "Media: list customer media",
  "suspension.cases.create": "Suspension: create case",
  "suspension.cases.update": "Suspension: update case",
  "seo.keywords.estimate": "SEO keyword research: price",
  "seo.keywords.research": "SEO keyword research: run search",
  "seo.keywords.get": "SEO keyword research: get results",
  "seo.cities.search": "SEO keyword research: find city",
};

const words = (seg: string) =>
  seg.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(" ").map((w) => WORDS[w] ?? w);

/** Human-readable MCP tool title (Connectors Directory requirement), derived from the action name. */
export function toolTitleFor(name: string): string {
  const fixed = TITLE_OVERRIDES[name];
  if (fixed) return fixed;
  const [group, ...rest] = name.split(".");
  const head = words(group!).join(" ");
  const tail = rest.length > 1 ? [...words(rest.at(-1)!), ...rest.slice(0, -1).flatMap(words)] : rest.flatMap(words);
  const t = tail.length ? `${head}: ${tail.join(" ")}` : head;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * MCP destructiveHint (Connectors Directory: destructive tools always prompt in Claude). True when a write deletes,
 * cancels, revokes or removes something, changes anything outside OpenGMB (every isExternalEffect action), moves money,
 * or spends AI or paid-API credit. False: additive or reversible changes inside OpenGMB. The test fails on an unclassified write.
 */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  ...PRIVATE_DESTRUCTIVE_ACTIONS,
  // Changes something outside OpenGMB (external-effects.ts)
  "webhooks.sendTest", "googleConnections.connect", "googleConnections.disconnect", "locations.import", "locations.setStatus",
  "reviewRequests.start", "reviewReplies.approve", "reviewReplies.publish", "reviewReplies.deletePublished", "workspaceSettings.update",
  "posts.approve", "posts.schedule", "posts.deletePublished", "posts.approveEdit", "reports.definitions.create",
  "reports.definitions.update", "reports.share", "profile.approve", "profile.apply", "googleNotifications.registerAll",
  "profile.autoRevert.set", "media.add", "media.upload", "media.uploadMany", "media.cancelScheduled", "media.delete",
  "placeActions.create", "placeActions.update", "placeActions.delete", "foodMenus.update",
  // Deletes, cancels, revokes, removes
  "workspaces.delete", "workspaces.erase_data", "apiTokens.revoke", "connectedApps.disconnect", "webhooks.unsubscribe",
  "locationGroups.delete", "reviewRequests.cancel", "citations.deleteCustom", "replyTemplates.delete", "postImages.delete",
  "postTemplates.delete", "posts.cancel", "posts.cancelEdit", "geogrid.configs.delete", "geogrid.byoKey.delete", "rankings.untrack",
  "reports.definitions.delete", "reports.share.revoke", "profile.cancel", "members.remove", "members.resetTwoFactor",
  "branding.removeLogo", "profile.changes.revert", "locations.center.clearManual", "mcp.proposals.cancel",
  // Runs whatever write was proposed
  "mcp.proposals.apply",
  // Looks like a draft but reaches outside (reviewed 2026-11-12): reviewReplies.submit can auto-approve and auto-publish to Google
  // (actions/reviewReplies.ts:428-453); the two campaign writes email recipients of an active campaign (review-requests/sweep.ts:83-91);
  // locationPages.set publishes a public page; webhooks.subscribe/setStatus send events to an outside URL.
  "reviewReplies.submit", "reviewRequests.addRecipients", "reviewRequests.importCsv", "locationPages.set", "webhooks.subscribe", "webhooks.setStatus",
  // Switches on recurring paid checks (spends credit)
  "aiVisibility.update", "rankings.track", "geogrid.configs.create", "geogrid.configs.update", "geogrid.settings.update", "reviewTopics.setAuto",
  // onboarding.firstDraft sends review text to the AI like every other AI tool, so Claude asks first (the platform pays, the user's credit is not spent).
  // Spends credit (traced 2026-11-12: every caller of debit() or assertCredit() in packages/core/src; reports.generate only when the definition has aiSummary)
  "ai.draftText", "ai.draftReply", "onboarding.firstDraft", "ai.draftReplies", "ai.draftBusinessDescription", "ai.draftServiceDescription",
  "ai.postIdeas", "ai.draftPost", "ai.draftPostVariants", "postImages.generate", "geogrid.run", "geogrid.quickScans.create",
  "aiVisibility.runNow", "reviews.classifyTopics", "reports.generate",
  // SEO1: a keyword research search spends DataForSEO credit
  "seo.keywords.research",
]);

/** Additive or reversible inside OpenGMB: drafts, notes, settings, templates, groups, tracking, rejects that send work back. */
export const NON_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  ...PRIVATE_NON_DESTRUCTIVE_ACTIONS,
  "workspaces.create", "workspaces.rename", "workspaces.setPostLanguage", "workspaces.setSenderIdentity", "workspaces.setHipaa",
  "workspaces.setTimeSettings", "apiTokens.create", "connectedApps.update", 
  "googleConnections.connectSample", "notifications.markRead", "locationGroups.create", "locationGroups.rename",
  "locationGroups.setMembers", "reviews.sync", "reviews.assign", "reviewNotes.add", "reviewLinks.save", "reviewRequests.create",
  "reviewRequests.update", "citations.save",
  "citations.addCustom", "citations.check", "citations.checkAll", "reviewReplies.createDraft", "reviewReplies.updateDraft",
  "reviewReplies.reject", "replyTemplates.create", "replyTemplates.update", "postImages.rename",
  "postImages.renderBranded", "postImages.addStock", "postTemplates.create", "postTemplates.update", "posts.createDraft",
  "posts.bulkCreateDrafts", "posts.updateDraft", "posts.submit", "posts.reject", "posts.proposeEdit", "posts.rejectEdit",
  "geogrid.byoKey.set",
  "geogrid.byoKey.verify", "rankings.setFavorite", "performance.backfill", "profile.propose", "profile.reject",
  "onboarding.update", "aiSwitch.update", "aiNotice.acknowledge", "branding.update", "profile.changes.accept",
  "profile.changes.dismiss", "suspension.cases.create", "suspension.cases.update", "locations.healthcheckSkip",
  "locations.center.set", "aiVoice.update", "aiUsage.setClientCap", 
]);

export function destructiveHintFor(action: Pick<AnyAction, "name" | "kind">): boolean {
  return action.kind === "write" && DESTRUCTIVE_ACTIONS.has(action.name);
}

const ADMIN_ONLY = "platform admin only: refused to every normal account (FORBIDDEN), so it cannot succeed for a directory user";
const REFUSED_TO_TOKENS =
  "always refused to API tokens and connected apps outside dryRun; the directory requires every tool to succeed with valid input";

/** Tools left out of the directory profile (OAuth connections), with the reason. Everything else is served. */
export const DIRECTORY_EXCLUDED: Readonly<Record<string, string>> = {
  ...PRIVATE_DIRECTORY_EXCLUDED,
  "postImages.generate": "AI image generation (Anthropic directory: connectors that generate images through AI models are not accepted)",
  "posts.approve": REFUSED_TO_TOKENS,
  "posts.schedule": REFUSED_TO_TOKENS,
  "posts.deletePublished": REFUSED_TO_TOKENS,
  "posts.approveEdit": REFUSED_TO_TOKENS,
  "reviewReplies.approve": REFUSED_TO_TOKENS,
  "reviewReplies.publish": REFUSED_TO_TOKENS,
  "reviewReplies.deletePublished": REFUSED_TO_TOKENS,
  "profile.approve": REFUSED_TO_TOKENS,
  "profile.apply": REFUSED_TO_TOKENS,
  "googleNotifications.registerAll": REFUSED_TO_TOKENS,
  "webhooks.sendTest": REFUSED_TO_TOKENS,
  "apiTokens.create": REFUSED_TO_TOKENS,
  "connectedApps.update": REFUSED_TO_TOKENS,
  "members.resetTwoFactor": REFUSED_TO_TOKENS,
  "postImages.delete": REFUSED_TO_TOKENS,
  "aiSwitch.update": REFUSED_TO_TOKENS + " (assertHumanBillingCaller)",
  "googleNotifications.status": ADMIN_ONLY,
  "monitoring.overview": ADMIN_ONLY,
};

/** The tools an OAuth connection is served: the registry minus DIRECTORY_EXCLUDED. */
export function directoryActions<T extends Pick<AnyAction, "name">>(list: readonly T[]): T[] {
  return list.filter((a) => !(a.name in DIRECTORY_EXCLUDED));
}
