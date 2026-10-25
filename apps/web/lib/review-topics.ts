// Pure helpers for the Topics panel (Reviews > Analytics) and the Reviews topic filter.
import { REVIEW_TOPIC_IDS, TOPIC_SENTIMENTS, type ReviewTopicId, type TopicSentiment } from "@opengmb/core/topics";

type Counts = { total: number; positive: number; negative: number; mixed: number };
export type TopicInput = Counts & { topic: ReviewTopicId; weekly: Counts[] };
export type TopicRow = Counts & {
  topic: ReviewTopicId;
  /** Whole percents of the topic's mentions; they add up to 100. */
  pct: { positive: number; mixed: number; negative: number };
  /** Negative share (0 to 1) of each week's mentions; null in a week with none. */
  weeklyNegative: (number | null)[];
  weekly: Counts[];
  trend: "up" | "down" | "flat" | "none";
};

/** Weeks at the end that count as "recent" when comparing the negative share with the weeks before. */
const RECENT_WEEKS = 4;
/** Fewest mentions each side needs before a trend is claimed. Our choice. */
const MIN_MENTIONS = 3;
/** Change in negative share (0 to 1) that counts as rising or falling. Our choice. */
const TREND_STEP = 0.1;

function trendOf(weekly: Counts[]): TopicRow["trend"] {
  const sum = (w: Counts[]) => w.reduce((a, x) => ({ total: a.total + x.total, negative: a.negative + x.negative }), { total: 0, negative: 0 });
  const recent = sum(weekly.slice(-RECENT_WEEKS));
  const before = sum(weekly.slice(0, -RECENT_WEEKS));
  if (recent.total < MIN_MENTIONS || before.total < MIN_MENTIONS) return "none";
  const d = recent.negative / recent.total - before.negative / before.total;
  return d >= TREND_STEP ? "up" : d <= -TREND_STEP ? "down" : "flat";
}

/** Topics with at least one mention, most mentioned first (ties by the fixed topic order). */
export function topicRows(topics: TopicInput[]): TopicRow[] {
  return topics
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => x.total > 0)
    .sort((a, b) => b.x.total - a.x.total || a.i - b.i)
    .map(({ x }) => {
      const positive = Math.round((x.positive / x.total) * 100);
      const negative = Math.round((x.negative / x.total) * 100);
      return {
        topic: x.topic,
        total: x.total,
        positive: x.positive,
        negative: x.negative,
        mixed: x.mixed,
        pct: { positive, negative, mixed: Math.max(0, 100 - positive - negative) },
        weekly: x.weekly,
        weeklyNegative: x.weekly.map((w) => (w.total === 0 ? null : w.negative / w.total)),
        trend: trendOf(x.weekly),
      };
    });
}

/** `?topic=` / `?sentiment=` as reviews.list inputs; anything unknown is undefined. */
export const parseTopic = (raw: string | null | undefined): ReviewTopicId | undefined =>
  REVIEW_TOPIC_IDS.find((id) => id === raw);
export const parseSentiment = (raw: string | null | undefined): TopicSentiment | undefined =>
  TOPIC_SENTIMENTS.find((s) => s === raw);
