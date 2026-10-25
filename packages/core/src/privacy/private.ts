import type { IncludedTable } from "./tables";

/** Community edition: no extra tables to export or erase. */
export const PRIVATE_INCLUDED_TABLES: readonly IncludedTable[] = [];

export const PRIVATE_EXCLUDED_TABLES: Readonly<Record<string, string>> = {};

export const PRIVATE_FIXTURE_OVERRIDES: Record<string, Record<string, unknown>> = {};

export const PRIVATE_FIXTURE_USER_KEYS: Record<string, string> = {};
