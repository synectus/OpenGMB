/**
 * "Ask OpenGMB" assistant limits and tool list. Our own product choices, not facts about anyone else's
 * service. Model id and prices stay in config/ai-models.ts.
 */
export const ASSISTANT = {
  /** Most tool calls one turn may make. The call after that is answered with an error, not run. */
  maxToolCallsPerTurn: 8,
  /** Most model calls one turn may make (every tool round trip is one). */
  maxModelCallsPerTurn: 10,
  /** Most user messages one conversation may hold. The browser keeps the conversation. */
  maxUserMessages: 20,
  /** Longest single message, characters. */
  maxMessageChars: 2_000,
  /** Longest tool result handed back to the model, characters; a longer one is cut with a note. */
  maxToolResultChars: 16_000,
  /** Output ceiling per model call, tokens; also what the pre-call cap check assumes will be spent. */
  maxOutputTokens: 1_500,
  /** Whole-turn deadline, ms, on top of the per-call timeout. */
  turnDeadlineMs: 120_000,
  /** The name of the hidden per-user token that owns the assistant's proposals. */
  tokenName: "Ask OpenGMB assistant",
  /**
   * Names the hidden token had before the rename; still found so nobody gets a second hidden token.
   * Stored rows keep their name.
   */
  legacyTokenNames: ["Ask SynGMB assistant"] as readonly string[],
} as const;

/**
 * Actions the assistant may call, by name. An explicit list, not a prefix match: all 200+ actions would
 * send ~70k tokens of schema on every model call. Reads run directly; writes are NEVER run, they become
 * proposals a person confirms. Left out on purpose: publishing and approving (a person does those),
 * mcp.proposals.* (the model must never confirm its own proposal), tokens, members, integrations,
 * deletes and anything that calls Google or spends money by itself.
 */
export const ASSISTANT_TOOLS = [
  // reads
  "workspaces.list",
  "locations.list",
  "locations.stats",
  "locations.overview",
  "locations.healthcheckSummary",
  "reviews.list",
  "reviews.list_unreplied",
  "reviews.get",
  "reviews.analytics",
  "reviews.assignees",
  "reviewNotes.list",
  "reviewReplies.list",
  "reviewReplies.check",
  "replyTemplates.list",
  "posts.list",
  "posts.get",
  "posts.calendar",
  "performance.summary",
  "performance.keywords",
  "performance.byLocation",
  "performance.activity",
  "approvals.counts",
  "attention.counts",
  "aiVoice.get",
  "search.everything",
  // writes (become proposals)
  "reviewReplies.createDraft",
  "reviewReplies.updateDraft",
  "reviewReplies.submit",
  "posts.createDraft",
  "reviews.assign",
  "reviewNotes.add",
] as const;
