import Link from "next/link";

/** Plan 5A creates /agents. Until then this link 404s. */
export const AGENTS_HREF = "/agents";

/**
 * Two-phase MCP writes (photos, suspension cases, groups, import...) wait in AI agents until the
 * token owner applies them. Never an approve button here. Static: no action can count them yet.
 */
export function AgentProposalNote({ what }: { what: string }) {
  return (
    <p className="rounded-control border border-agent-border bg-agent-bg px-3 py-2 text-[13px] leading-5 text-agent">
      Agents connected over MCP send {what} as Agent proposals. Only the token owner can apply
      them, in{" "}
      <Link
        href={AGENTS_HREF}
        className="font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        AI agents
      </Link>
      .
    </p>
  );
}
