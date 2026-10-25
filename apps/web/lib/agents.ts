// Pure helpers for /agents. Client-safe: no server imports.
import { fieldLabel } from "./approvals";
import { guardrailLabel } from "./labels";
import { failureLabel } from "./failure-labels";
import type { TimeFormat } from "./time-format";

/** A next-intl translator scoped to the "agents" namespace (keys are not type checked). */
export type AgentsT = (key: string, values?: Record<string, string | number>) => string;

export const AGENT_VIEWS = [{ key: "connect" }, { key: "proposals" }, { key: "resources" }] as const;
export type AgentView = (typeof AGENT_VIEWS)[number]["key"];

export const PROPOSAL_FILTERS = [
  { key: "pending" },
  { key: "applied" },
  { key: "expired" },
  { key: "cancelled" },
  { key: "failed" },
  { key: "all" },
] as const;
export type ProposalFilter = (typeof PROPOSAL_FILTERS)[number]["key"];

export function parseView(v: string | undefined): AgentView {
  return AGENT_VIEWS.find((x) => x.key === v)?.key ?? "connect";
}

export function parseProposalFilter(v: string | undefined): ProposalFilter {
  return PROPOSAL_FILTERS.find((x) => x.key === v)?.key ?? "pending";
}

export function agentsHref(o: {
  view?: AgentView;
  status?: ProposalFilter;
  proposal?: string | null;
}): string {
  const q = new URLSearchParams();
  if (o.view && o.view !== "connect") q.set("view", o.view);
  if (o.status && o.status !== "pending") q.set("status", o.status);
  if (o.proposal) q.set("proposal", o.proposal);
  const s = q.toString();
  return s ? `/agents?${s}` : "/agents";
}

type Preview = {
  summary?: unknown;
  diff?: unknown;
  findings?: { ok?: boolean; violations?: { severity?: string; ruleId?: string }[] };
} | null;

/** core's runPreview fallback: "Would run <action>. This action has no detailed preview; ..." */
const GENERIC = /^Would run \S+\. /;

export function proposalTitle(action: string, preview: unknown, t: AgentsT): string {
  const s = (preview as Preview)?.summary;
  if (typeof s !== "string" || s === "" || GENERIC.test(s)) return t("proposals.runAction", { action });
  const first = s.split(/(?<=\.)\s/)[0] ?? s;
  return first.length > 120 ? `${first.slice(0, 119).trimEnd()}…` : first;
}

export type PreviewRow = { field: string; value: string; mono: boolean };

const shown = (v: unknown, t: AgentsT) =>
  typeof v === "string" ? v : typeof v === "boolean" ? (v ? t("proposals.yes") : t("proposals.no")) : JSON.stringify(v);

/** The "What it will do" table. Generic previews carry { input }: one row per input field. */
export function previewRows(action: string, preview: unknown, t: AgentsT): PreviewRow[] {
  const rows: PreviewRow[] = [{ field: t("proposals.rowAction"), value: action, mono: true }];
  const diff = (preview as Preview)?.diff;
  const src =
    diff && typeof diff === "object" && !Array.isArray(diff) && "input" in diff
      ? (diff as { input: unknown }).input
      : diff;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) {
      const value = shown(v, t);
      rows.push({
        field: fieldLabel(k),
        value,
        mono: typeof v === "object" || /^https?:\/\//.test(value),
      });
    }
  } else if (src !== undefined && src !== null) {
    rows.push({ field: t("proposals.rowChange"), value: JSON.stringify(src), mono: true });
  }
  return rows;
}

export function policyLine(preview: unknown, t: AgentsT): { ok: boolean; text: string } {
  const blocks = ((preview as Preview)?.findings?.violations ?? [])
    .filter((v) => v.severity === "block")
    .map((v) => guardrailLabel(v.ruleId, null));
  return blocks.length === 0
    ? { ok: true, text: t("proposals.policyPassed") }
    : { ok: false, text: t("proposals.policyBlocked", { rules: blocks.join(", ") }) };
}

/** "in 11 min" while pending (soon at 5 or less), else the expiry time in the page's zone (`tf` is needed only then). */
export function expiryLabel(
  status: string,
  expiresAt: string,
  now: number,
  tf?: TimeFormat,
  inMin: (mins: number) => string = (mins) => `in ${mins} min`,
) {
  if (status === "pending") {
    const mins = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
    return { text: inMin(mins), soon: mins <= 5 };
  }
  if (!tf) throw new Error("expiryLabel needs a TimeFormat once a proposal is no longer pending");
  return { text: tf.time(expiresAt), soon: false };
}

/** In the page's zone: "09:41" when made today, else "2026-10-17 23:59". */
export function madeLabel(createdAt: string, now: number, tf: TimeFormat): string {
  return tf.dayKey(createdAt) === tf.dayKey(now) ? tf.time(createdAt) : tf.dateTime(createdAt);
}

/** A failed proposal's stored "CODE: message"; older rows hold only a message. */
export function proposalError(error: string | null): { code: string; message: string } | null {
  if (!error) return null;
  const m = /^([A-Za-z_]+): ([\s\S]*)$/.exec(error);
  if (!m) return { code: "failed", message: error };
  const label = failureLabel(m[1]!);
  return { code: m[1]!, message: label === m[1] ? m[2]! : `${label}.` };
}

const ROLE_ORDER = ["owner", "admin", "manager", "client_approver", "client_viewer"] as const;
const ROLE_KEY: Record<(typeof ROLE_ORDER)[number], string> = {
  owner: "roleOwner",
  admin: "roleAdmin",
  manager: "roleManager",
  client_approver: "roleClientApprover",
  client_viewer: "roleClientViewer",
};

/** Who can read a resource, from the roles that hold its permission (computed by the page). */
export function resourceAudience(rolesWith: readonly string[], t: AgentsT): string {
  if (ROLE_ORDER.every((r) => rolesWith.includes(r))) return t("resources.anyRole");
  const names = ROLE_ORDER.filter((r) => rolesWith.includes(r)).map((r) => t(`resources.${ROLE_KEY[r]}`));
  const list =
    names.length === 1
      ? names[0]!
      : t("resources.listAnd", { rest: names.slice(0, -1).join(", "), last: names.at(-1)! });
  const text = t("resources.rolesOnly", { list });
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
