import type { roleHasPermission } from "@opengmb/core";

export const ReadOnlyBanner = (_props: { role: Parameters<typeof roleHasPermission>[0] }): null => null;
