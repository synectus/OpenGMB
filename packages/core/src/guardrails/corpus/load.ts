import hipaaCorpus from "./hipaa.json";
import legalCorpus from "./legal_ethics.json";
import postsCorpus from "./posts.json";
import profileCorpus from "./profile.json";
import universalCorpus from "./universal.json";
import type { GuardrailContext, PackId, PostFields, ProfileGuardFields } from "../types";

export type Rating = 1 | 2 | 3 | 4 | 5 | null;
export interface ContextFields {
  contentType?: "reply" | "post" | "profile";
  post?: PostFields;
  profileFields?: ProfileGuardFields;
  packs: PackId[];
  profile: "general" | "healthcare" | "legal";
  rating: Rating;
  reviewText: string | null;
  reviewerDisplayName: string | null;
  locationName: string;
  phone: string | null;
  staffNames: string[];
  skipPositiveReviews: boolean;
  recentReplies: string[];
  /** Number of unique unrelated replies placed (newest first) before `recentReplies`. */
  recentFiller: number;
}
export interface Entry {
  id: string;
  reply: string | { repeat: string; times: number };
  context: Partial<ContextFields>;
  expect: { ok: boolean; ruleIds: string[] };
}
export interface CorpusFile {
  defaults: ContextFields;
  entries: Entry[];
}

export const CORPUS_FILES: Record<string, CorpusFile> = {
  universal: universalCorpus as unknown as CorpusFile,
  hipaa: hipaaCorpus as unknown as CorpusFile,
  legal_ethics: legalCorpus as unknown as CorpusFile,
  posts: postsCorpus as unknown as CorpusFile,
  profile: profileCorpus as unknown as CorpusFile,
};

export function corpusContext(
  file: CorpusFile,
  entry: Entry,
  severityOverrides?: Record<string, "block" | "warn">,
): GuardrailContext {
  const c: ContextFields = { ...file.defaults, ...entry.context };
  // Post fixtures override single fields of the default post.
  const post = c.contentType === "post" ? { ...file.defaults.post, ...entry.context.post } : null;
  const filler = Array.from(
    { length: c.recentFiller },
    (_, i) => `Unrelated filler reply number ${i + 1}.`,
  );
  const reply =
    typeof entry.reply === "string" ? entry.reply : entry.reply.repeat.repeat(entry.reply.times);
  return {
    ...(post ? { contentType: "post" as const, post: post as PostFields } : {}),
    ...(c.contentType === "profile"
      ? {
          contentType: "profile" as const,
          profile: { ...(reply ? { description: reply } : {}), ...c.profileFields },
        }
      : {}),
    reply,
    review: { rating: c.rating, text: c.reviewText, reviewerDisplayName: c.reviewerDisplayName },
    location: { name: c.locationName, phone: c.phone },
    workspace: {
      profile: c.profile,
      packs: c.packs,
      skipPositiveReviews: c.skipPositiveReviews,
      staffNames: c.staffNames,
      ...(severityOverrides ? { severityOverrides } : {}),
    },
    recentReplies: [...filler, ...c.recentReplies],
  };
}

/** The reply text of a corpus entry (expands `repeat`). */
export function corpusReply(entry: Entry): string {
  return typeof entry.reply === "string" ? entry.reply : entry.reply.repeat.repeat(entry.reply.times);
}

/** The corpus fields of an entry: the file defaults with the entry's overrides (the `post` field is merged by the caller). */
export function corpusFields(file: CorpusFile, entry: Entry): ContextFields {
  return { ...file.defaults, ...entry.context };
}
