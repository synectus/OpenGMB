type Env = Record<string, string | undefined>;

/** Community edition: no extra secrets and no extra startup fields. */
export const HOSTED_SECRETS: readonly { name: string; requiredBy: readonly [] }[] = [];

export const hostedWebStartupFields = (_env: Env, _secrets: Record<string, string>): string => "";
