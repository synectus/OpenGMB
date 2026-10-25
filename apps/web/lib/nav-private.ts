import type { SettingsDef } from "./settings-nav";

export const PRIVATE_SETTINGS: (SettingsDef & { after: string })[] = [];

/** First-run checklist steps this build leaves out (the key is `step.<key>` in the home messages). */
export const HIDDEN_SETUP_STEPS: readonly string[] = ["team"];
