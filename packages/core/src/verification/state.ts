import type { GoogleVoiceOfMerchantState } from "../google/client";

export const STANDINGS = [
  "good_standing",
  "wait_for_review",
  "verify",
  "comply_with_guidelines",
  "resolve_ownership_conflict",
  "unknown",
] as const;
export type Standing = (typeof STANDINGS)[number];

/**
 * Reads Google's VoiceOfMerchantState (Verifications API v1). The sub-states are empty messages, so
 * their PRESENCE is the signal (`{}` is truthy, absent is not), and proto3 JSON omits false
 * booleans, so absent means false. `standing` is the single most urgent thing, in this order: a
 * guideline problem (suspension-like), an ownership conflict (duplicate of a location in good
 * standing), verification needed, under review, otherwise good standing when Google says the
 * merchant has voice.
 */
export function describeVoiceOfMerchant(s: GoogleVoiceOfMerchantState) {
  const comply = s.complyWithGuidelines !== undefined && s.complyWithGuidelines !== null;
  const conflict = s.resolveOwnershipConflict !== undefined && s.resolveOwnershipConflict !== null;
  const verify = s.verify !== undefined && s.verify !== null;
  const wait = s.waitForVoiceOfMerchant !== undefined && s.waitForVoiceOfMerchant !== null;
  const hasVoice = s.hasVoiceOfMerchant ?? false;
  const standing: Standing = comply
    ? "comply_with_guidelines"
    : conflict
      ? "resolve_ownership_conflict"
      : verify
        ? "verify"
        : wait
          ? "wait_for_review"
          : hasVoice
            ? "good_standing"
            : "unknown";
  return {
    standing,
    hasVoiceOfMerchant: hasVoice,
    hasBusinessAuthority: s.hasBusinessAuthority ?? false,
    waitForVoiceOfMerchant: wait,
    needsVerification: verify,
    hasPendingVerification: s.verify?.hasPendingVerification ?? false,
    complyWithGuidelines: comply,
    recommendationReason: s.complyWithGuidelines?.recommendationReason ?? null,
    resolveOwnershipConflict: conflict,
  };
}
