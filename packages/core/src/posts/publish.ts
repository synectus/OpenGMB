import { postSubject, type GuardrailPassed } from "../guardrails";
import type { GoogleLocalPost } from "../google/client";
import type { ThrottledGoogleClient } from "../google/throttled-client";
import { fieldsOf, toGoogleLocalPost, type EditField, type PostContent } from "./content";

/**
 * The ONLY place outside the Google client implementations that writes a local post to Google. A
 * test (`reply-enforcement.test.ts`) fails if any other source file calls `.createLocalPost(`,
 * `.updateLocalPost(` or `.deleteLocalPost(`. Create and update take a `GuardrailPassed`, which
 * only `assertPassed` can build from a `runGuardrails` result, and additionally check that it was
 * issued for EXACTLY the content being sent (summary, topic, CTA, event, offer, media), so a field
 * changed after the check cannot ride on an earlier pass.
 */
export type PostWriter = Pick<
  ThrottledGoogleClient,
  "createLocalPost" | "updateLocalPost" | "deleteLocalPost"
>;

/** Idempotency key for sending one occurrence of a post to one location. */
export const postPublishKey = (postId: string, locationId: string, occurrence: number) =>
  `post:${postId}:${locationId}:${occurrence}`;

/** Idempotency key for deleting the Google post a target published. */
export const postDeleteKey = (targetId: string) => `postdelete:${targetId}`;

// The language is not part of the guardrail subject: it is not text Google shows, and it can only
// change while the post is draft or blocked (posts.updateDraft), which forces a new submit and check.
function assertIssuedFor(content: PostContent, passed: GuardrailPassed) {
  if (passed.reply !== postSubject(content.summary, fieldsOf(content))) {
    throw new Error("Post content differs from the content that passed the guardrails");
  }
}

/** Create the post at `parent` (`accounts/{a}/locations/{l}`). Returns what Google stored. */
export function publishPost(
  client: PostWriter,
  p: {
    orgId: string;
    postId: string;
    locationId: string;
    occurrence: number;
    parent: string;
    languageCode: string;
  },
  content: PostContent,
  passed: GuardrailPassed,
): Promise<GoogleLocalPost> {
  assertIssuedFor(content, passed);
  return client.createLocalPost(p.parent, toGoogleLocalPost(content, p.languageCode), {
    orgId: p.orgId,
    idempotencyKey: postPublishKey(p.postId, p.locationId, p.occurrence),
  });
}

/**
 * Patch an already published Google post (`localPosts.patch`). Only the fields in `changed` are
 * named in the updateMask (see `changedEditFields`); a field in the mask but absent from the body
 * is cleared on Google. The caller is the edit worker (`processPostEdit`), after a person approved
 * the edit and the guardrails passed for this location. `revision` (the edit's) keeps the
 * idempotency key unique per edit and target.
 */
export function updatePublishedPost(
  client: PostWriter,
  p: {
    orgId: string;
    targetId: string;
    postName: string;
    revision: number;
    changed: readonly EditField[];
  },
  content: PostContent,
  passed: GuardrailPassed,
): Promise<GoogleLocalPost> {
  assertIssuedFor(content, passed);
  if (p.changed.length === 0) throw new Error("An edit with no changed field has nothing to patch");
  return client.updateLocalPost(p.postName, toGoogleLocalPost(content), [...p.changed], {
    orgId: p.orgId,
    idempotencyKey: `postupdate:${p.targetId}:${p.revision}`,
  });
}

/** Remove a Google post. Needs no GuardrailPassed (no text is sent). */
export function removeGooglePost(
  client: PostWriter,
  p: { orgId: string; targetId: string; postName: string },
): Promise<void> {
  return client.deleteLocalPost(p.postName, {
    orgId: p.orgId,
    idempotencyKey: postDeleteKey(p.targetId),
  });
}
