import type { Db, Tx } from "@opengmb/db";
import { readCounter } from "./counters";

/** The platform event count for one UTC hour (read only). */
export const bumpCounterRead = (db: Db | Tx, kind: string, hour: string) => readCounter(db, "platform", kind, hour);
