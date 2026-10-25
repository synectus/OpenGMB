import { sql, type SQL } from "drizzle-orm";
import { reviews } from "@opengmb/db";
import type { ReviewTopicId, TopicSentiment } from "../config/review-topics";

/** sha256 (hex) of the review text exactly as stored. The same value as {@link hashReviewText}. */
export const commentHashSql = sql`encode(sha256(convert_to(${reviews.comment}, 'UTF8')), 'hex')`;

/**
 * Reviews whose stored classification is current (made from the text as it is now) and matches.
 * With a topic: that topic is present, and with a sentiment, that topic has it. With only a sentiment:
 * the review's overall sentiment. An edited review that has not been classified again matches nothing.
 */
export function topicCondition(f: { topic?: ReviewTopicId; sentiment?: TopicSentiment }): SQL | undefined {
  if (!f.topic && !f.sentiment) return undefined;
  const match = f.topic
    ? sql`rt.topics @> ${JSON.stringify([f.sentiment ? { topic: f.topic, sentiment: f.sentiment } : { topic: f.topic }])}::jsonb`
    : sql`rt.overall_sentiment = ${f.sentiment}`;
  return sql`exists (select 1 from review_topics rt where rt.review_id = ${reviews.id} and rt.status = 'classified' and rt.text_hash = ${commentHashSql} and ${match})`;
}
