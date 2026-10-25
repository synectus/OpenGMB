import { PRIVATE_EXCLUDED_TABLES, PRIVATE_INCLUDED_TABLES } from "./private";

/**
 * Every table in the database and what the client (workspace) data export and delete do with it.
 * The structure test (tables.test.ts) reads information_schema and fails on any table that is not
 * listed here, so a new table cannot be silently missed.
 *
 * Scopes (what makes a row belong to the client):
 * - workspace: `workspace_id` equals the client.
 * - location:  `location_id` is a location of the client.
 * - parent:    `column` points at the `id` of a row of another listed table that is itself in scope.
 * - self:      the client's own row (workspaces.id).
 * - excluded:  not the client's data (account, organization, secret or shared). The reason is the doc.
 */
export type TableScope =
  | { kind: "workspace" }
  | { kind: "location" }
  | { kind: "parent"; column: string; parent: string }
  | { kind: "self" };

export type IncludedTable = {
  table: string;
  scope: TableScope;
  /** Columns left out of the export (secrets). They are not data the client can use. */
  omit?: readonly string[];
};

/**
 * Included tables in DELETE ORDER: children before the rows they point at. The structure test checks
 * this against the real foreign keys. Export uses the same list.
 */
export const INCLUDED_TABLES: readonly IncludedTable[] = [
  ...PRIVATE_INCLUDED_TABLES,
  { table: "webhook_deliveries", scope: { kind: "workspace" }, omit: ["payload"] },
  { table: "webhook_subscriptions", scope: { kind: "workspace" }, omit: ["secret_enc"] },
  { table: "review_request_recipients", scope: { kind: "workspace" }, omit: ["link_token"] },
  { table: "review_request_campaigns", scope: { kind: "workspace" } },
  { table: "review_request_optouts", scope: { kind: "workspace" } },
  { table: "review_link_clicks", scope: { kind: "parent", column: "link_id", parent: "review_links" } },
  { table: "report_share_links", scope: { kind: "parent", column: "report_run_id", parent: "report_runs" }, omit: ["token_hash"] },
  { table: "report_runs", scope: { kind: "parent", column: "definition_id", parent: "report_definitions" } },
  { table: "report_definitions", scope: { kind: "workspace" } },
  { table: "grid_competitor_snapshots", scope: { kind: "location" } },
  { table: "ai_visibility_results", scope: { kind: "parent", column: "run_id", parent: "ai_visibility_runs" } },
  { table: "ai_visibility_runs", scope: { kind: "location" } },
  { table: "ai_visibility_settings", scope: { kind: "location" } },
  { table: "location_data_access", scope: { kind: "location" } },
  { table: "grid_points", scope: { kind: "parent", column: "run_id", parent: "grid_runs" } },
  { table: "grid_tasks", scope: { kind: "parent", column: "run_id", parent: "grid_runs" }, omit: ["token_hash"] },
  { table: "grid_runs", scope: { kind: "parent", column: "config_id", parent: "grid_configs" } },
  { table: "grid_configs", scope: { kind: "workspace" } },
  { table: "review_assignments", scope: { kind: "workspace" } },
  { table: "review_auto_drafts", scope: { kind: "workspace" } },
  { table: "review_notes", scope: { kind: "workspace" } },
  { table: "review_replies", scope: { kind: "workspace" } },
  { table: "review_links", scope: { kind: "workspace" } },
  { table: "location_pages", scope: { kind: "workspace" } },
  { table: "review_topics", scope: { kind: "workspace" } },
  { table: "reviews", scope: { kind: "workspace" } },
  { table: "review_syncs", scope: { kind: "location" } },
  { table: "post_targets", scope: { kind: "parent", column: "post_id", parent: "posts" } },
  { table: "post_edits", scope: { kind: "workspace" } },
  { table: "post_templates", scope: { kind: "workspace" } },
  { table: "post_images", scope: { kind: "workspace" } },
  { table: "stored_files", scope: { kind: "workspace" } },
  { table: "posts", scope: { kind: "workspace" } },
  { table: "profile_change_targets", scope: { kind: "parent", column: "change_set_id", parent: "profile_change_sets" } },
  { table: "profile_changes", scope: { kind: "location" } },
  { table: "profile_change_sets", scope: { kind: "workspace" } },
  { table: "profile_snapshots", scope: { kind: "location" } },
  { table: "customer_media_scans", scope: { kind: "location" } },
  { table: "location_auto_revert", scope: { kind: "location" } },
  { table: "customer_media_seen", scope: { kind: "location" } },
  { table: "google_notifications", scope: { kind: "location" } },
  { table: "google_media", scope: { kind: "location" } },
  { table: "google_posts", scope: { kind: "location" } },
  { table: "healthcheck_skips", scope: { kind: "location" } },
  { table: "location_group_members", scope: { kind: "location" } },
  { table: "location_write_ops", scope: { kind: "location" } },
  { table: "media_uploads", scope: { kind: "location" } },
  { table: "performance_daily", scope: { kind: "location" } },
  { table: "performance_snapshots", scope: { kind: "location" } },
  { table: "search_keywords_monthly", scope: { kind: "location" } },
  { table: "suspension_cases", scope: { kind: "location" } },
  { table: "citation_entries", scope: { kind: "workspace" } },
  { table: "location_groups", scope: { kind: "workspace" } },
  { table: "location_imports", scope: { kind: "workspace" } },
  { table: "reply_templates", scope: { kind: "workspace" } },
  { table: "ai_usage", scope: { kind: "workspace" } },
  { table: "workspace_ai_settings", scope: { kind: "workspace" } },
  { table: "workspace_review_topic_settings", scope: { kind: "workspace" } },
  { table: "workspace_reply_settings", scope: { kind: "workspace" } },
  { table: "memberships", scope: { kind: "workspace" } },
  { table: "locations", scope: { kind: "workspace" } },
  { table: "workspaces", scope: { kind: "self" } },
];

/** Tables that are not exported or deleted with a client, each with the reason. */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  ...PRIVATE_EXCLUDED_TABLES,
  users: "A person's account. One person can work for several clients; accounts are not client data.",
  sessions: "Sign-in sessions of an account.",
  accounts: "Sign-in credentials of an account (password hash, provider ids). Secret.",
  verifications: "One-time email verification and reset tokens. Secret.",
  two_factors: "Two-factor secrets and backup codes of an account. Secret.",
  organizations: "The agency account that owns the client. Not the client's data.",
  error_events: "Server-wide error log for monitoring (H2). No org or client id; messages are stripped of secrets, emails and ids.",
  monitor_state: "Server-wide monitoring state such as the worker heartbeat (H2). No client data.",
  google_api_calls: "Server-wide daily Google API call counts per method (H2). Counts only, no client data.",
  limit_counters: "Server-wide counters per account and day or per hour (OPS1): daily action caps and limit-hit counts. Counts only; the scope is an organization id, no client content.",
  org_branding: "Agency branding for the organization.",
  org_grid_settings: "Agency-level rank tracking settings.",
  org_dataforseo_credentials: "The agency's own DataForSEO key (encrypted). Secret.",
  api_tokens: "Agency API tokens (hashes). Secret and organization-wide.",
  google_connections: "The agency's Google sign-in (encrypted refresh token). Secret, and shared by many clients.",
  google_oauth_states: "Short-lived OAuth state for a Google connect in progress. Secret.",
  google_notification_registrations: "Whether a Google account points its notifications at our Pub/Sub topic. Organization-wide, no client data.",
  google_rate_windows: "Request counters for Google's rate limit. No personal data.",
  google_idempotency_keys: "Short-lived duplicate-request guards for Google calls. Organization-wide.",
  job_runs: "Background job run log. No client data.",
  audit_log: "Append-only and hash-chained: rows cannot be removed without breaking verification. Exported by a separate query, kept on delete.",
  audit_checkpoints: "Signed head of the audit chain for the organization.",
  notifications: "A person's in-app inbox, organization level. Not scoped to a client.",
  push_subscriptions: "A person's own devices for push notifications (browser endpoint and keys). Secret, and an account-level setting, not client data.",
  notification_digests: "A person's email digest state. Not scoped to a client.",
  competitor_profiles: "Public Google profile of a competitor business (place id, rating, categories) fetched for the agency. Keyed by org and place id, not linked to any client or location.",
  competitor_profile_tasks: "DataForSEO task bookkeeping and the agency's charge for fetching competitor profiles. Keyed by org and place id, not linked to any client; counts toward the agency's budget.",
  platform_dfs_spend: "Platform accounting of our own DataForSEO calls (kind and cost). Never charged to a customer. Its location link is ON DELETE SET NULL, so erasing a client keeps the cost row and drops the link.",
  mcp_proposals: "Agency agent proposals, organization level. Kept until they expire.",
};

/**
 * Schemas other than `public` that exist on purpose. `drizzle` holds migration bookkeeping. `pgboss`
 * (the worker's job queue, created at worker start, so absent from a migrated test database) holds
 * ids of work in flight (post, reply, location, report ids), never text; a job for an erased client
 * finds nothing and ends. Neither is client data. A new schema fails the structure test.
 */
export const OTHER_SCHEMAS: readonly string[] = ["drizzle", "pgboss"];

export const INCLUDED_NAMES: readonly string[] = INCLUDED_TABLES.map((t) => t.table);

/** Column names that look like a secret. An included table with one that is not in `omit` blocks the export. */
export const SECRET_COLUMN = /token_hash|_enc$|password|secret|totp|refresh_token|api_key/i;
