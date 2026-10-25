import type { ContentType, GuardrailContext } from "../types";

/**
 * A rule's message for each content type it runs on. `reply` is the original reply wording and
 * must stay byte-identical. A rule only runs for its `contentTypes`, and `messages.test.ts` walks
 * every shared rule, so a missing entry is caught there rather than silently reading "Reply".
 */
export type Wording = { reply: string } & Partial<Record<Exclude<ContentType, "reply">, string>>;

/** The message for the content type being checked (absent = reply, as in the engine). */
export function say(ctx: GuardrailContext, wording: Wording): string {
  return wording[ctx.contentType ?? "reply"] ?? wording.reply;
}
