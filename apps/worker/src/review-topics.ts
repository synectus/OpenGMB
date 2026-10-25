import type { PgBoss } from "pg-boss";
import { REVIEW_TOPIC_CONFIG, sweepReviewTopics } from "@opengmb/core";
import type { Db } from "@opengmb/db";

export const REVIEW_TOPICS_SWEEP_QUEUE = "review-topics-sweep";

/**
 * A5: daily, classify new reviews by topic and sentiment for the clients that turned it on (off by default).
 * Only reviews with no current classification are sent, so an unchanged review is never paid for twice.
 */
export async function registerReviewTopicJobs(boss: PgBoss, db: Db) {
  await boss.createQueue(REVIEW_TOPICS_SWEEP_QUEUE);
  await boss.schedule(REVIEW_TOPICS_SWEEP_QUEUE, REVIEW_TOPIC_CONFIG.sweepCron, {}, { tz: "UTC" });
  await boss.work(REVIEW_TOPICS_SWEEP_QUEUE, async () => {
    const r = await sweepReviewTopics(db);
    console.log(`[worker] ${REVIEW_TOPICS_SWEEP_QUEUE}: ${JSON.stringify(r)}`);
  });
}
