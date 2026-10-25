import type { PackId, Rule } from "../types";
import { hipaaRules } from "./hipaa";
import { legalEthicsRules } from "./legal-ethics";
import { postRules } from "./post";
import { profileRules } from "./profile";
import { universalRules } from "./universal";

/** Every pack's rules, in the order they run. Adding a pack means adding it here. */
export const PACK_RULES: Record<PackId, readonly Rule[]> = {
  universal: universalRules,
  hipaa: hipaaRules,
  legal_ethics: legalEthicsRules,
  post: postRules,
  profile: profileRules,
};

export const PACK_ORDER: readonly PackId[] = [
  "universal",
  "hipaa",
  "legal_ethics",
  "post",
  "profile",
];

export function allRules(): Rule[] {
  return PACK_ORDER.flatMap((p) => [...PACK_RULES[p]]);
}
