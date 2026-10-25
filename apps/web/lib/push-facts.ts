import { getPushFacts } from "@opengmb/core";
import { getDb } from "./auth";
import type { PushFacts } from "./live-status";

/** Registered Google accounts and the latest push, for the "Instant review alerts" row. Server only. */
export const pushFacts = (): Promise<PushFacts> => getPushFacts(getDb());
