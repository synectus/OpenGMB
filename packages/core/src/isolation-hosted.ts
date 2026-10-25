// Community edition: no hosted-only rows or fields for the isolation sweep.
export const HOSTED_POOL_ROWS: { key: string; table: string; ctx: (userId: string) => Record<string, unknown>; over: Record<string, unknown> }[] = [];

export const HOSTED_ID_KIND: [prefix: string, key: string][] = [];

export const HOSTED_NON_TENANT_ID_FIELDS: Record<string, string> = {};

export const HOSTED_NO_TENANT_INPUT: Record<string, string> = {};
