import type { Widen } from "../en";

/**
 * One page group's messages in all three languages, in one file, so parallel work on different
 * pages never edits the same file. Hindi and Spanish must match English's keys (a type error if not;
 * i18n.test.ts checks the merged result too). Hindi and Spanish here are MACHINE DRAFTS.
 */
export function namespace<const T extends Record<string, unknown>>(m: { en: T; hi: Widen<T>; es: Widen<T> }) {
  return m;
}
