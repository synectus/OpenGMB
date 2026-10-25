import "server-only";
import { executeAction, loadActor } from "@opengmb/core";
import { getDb } from "./auth";

export type BellItem = {
  id: string;
  kind: string;
  title: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
};
export type BellData = { unreadCount: number; items: BellItem[] };

/** The header bell's data, read through the same action the client uses. null = no bell. */
export async function bellDataFor(userId: string): Promise<BellData | null> {
  try {
    const db = getDb();
    const actor = await loadActor(db, { userId, surface: "ui", actorType: "user" });
    return (await executeAction(db, actor, "notifications.list", { limit: 10 })) as BellData;
  } catch (e) {
    // No membership yet, or several organizations without a chooser: render without a bell.
    console.warn("[web] notification bell unavailable", e instanceof Error ? e.message : e);
    return null;
  }
}
