import { REVIEW_TOPICS, REVIEW_TOPIC_CONFIG, type ReviewTopicId, type TopicSentiment } from "../config/review-topics";

/** Plain arithmetic over classified reviews. No review text, reviewer names or AI in this module. */
export type TrendRow = {
  locationId: string;
  locationName: string;
  createTime: Date;
  overall: TopicSentiment;
  topics: { topic: ReviewTopicId; sentiment: TopicSentiment }[];
};

export type Counts = { total: number; positive: number; negative: number; mixed: number };
export type TopicLine = Counts & {
  topic: ReviewTopicId;
  label: string;
  /** Share of this topic's mentions, 0 to 1; null when there are none. */
  positiveShare: number | null;
  negativeShare: number | null;
};
export type Trends = {
  /** Monday (UTC) of each week, oldest first; the last is the current week. */
  weeks: string[];
  classifiedReviews: number;
  overall: Omit<Counts, "total">;
  topics: (TopicLine & { weekly: Counts[] })[];
  locations: { locationId: string; name: string; classifiedReviews: number; topics: TopicLine[] }[];
};

const DAY = 86_400_000;
/** Monday 00:00 UTC of the week containing `d`. */
export function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY);
}

/** The first instant the trend window covers: Monday of the oldest week. */
export function trendWindowStart(now: Date, weeks = REVIEW_TOPIC_CONFIG.trendWeeks): Date {
  return new Date(weekStart(now).getTime() - (weeks - 1) * 7 * DAY);
}

const empty = (): Counts => ({ total: 0, positive: 0, negative: 0, mixed: 0 });
const bump = (c: Counts, s: TopicSentiment) => {
  c.total++;
  c[s]++;
};
const share = (n: number, total: number) => (total === 0 ? null : Math.round((n / total) * 1000) / 1000);
const line = (topic: ReviewTopicId, c: Counts): TopicLine => ({
  topic,
  label: REVIEW_TOPICS.find((t) => t.id === topic)!.label,
  ...c,
  positiveShare: share(c.positive, c.total),
  negativeShare: share(c.negative, c.total),
});

export function computeTopicTrends(rows: TrendRow[], now: Date, weeks = REVIEW_TOPIC_CONFIG.trendWeeks): Trends {
  const start = trendWindowStart(now, weeks).getTime();
  const weekKeys = Array.from({ length: weeks }, (_, i) => new Date(start + i * 7 * DAY).toISOString().slice(0, 10));
  const overall = { positive: 0, negative: 0, mixed: 0 };
  const byTopic = new Map(REVIEW_TOPICS.map((t) => [t.id, { all: empty(), weekly: weekKeys.map(empty) }]));
  const byLoc = new Map<string, { name: string; reviews: number; topics: Map<ReviewTopicId, Counts> }>();
  let classifiedReviews = 0;
  for (const r of rows) {
    const t = r.createTime.getTime();
    if (t < start || t >= start + weeks * 7 * DAY) continue;
    const w = Math.floor((t - start) / (7 * DAY));
    classifiedReviews++;
    overall[r.overall]++;
    const loc = byLoc.get(r.locationId) ?? { name: r.locationName, reviews: 0, topics: new Map() };
    byLoc.set(r.locationId, loc);
    loc.reviews++;
    for (const m of r.topics) {
      const slot = byTopic.get(m.topic);
      if (!slot) continue;
      bump(slot.all, m.sentiment);
      bump(slot.weekly[w]!, m.sentiment);
      const lc = loc.topics.get(m.topic) ?? empty();
      loc.topics.set(m.topic, lc);
      bump(lc, m.sentiment);
    }
  }
  return {
    weeks: weekKeys,
    classifiedReviews,
    overall,
    topics: REVIEW_TOPICS.map((t) => ({ ...line(t.id, byTopic.get(t.id)!.all), weekly: byTopic.get(t.id)!.weekly })),
    locations: [...byLoc.entries()]
      .map(([locationId, l]) => ({
        locationId,
        name: l.name,
        classifiedReviews: l.reviews,
        topics: REVIEW_TOPICS.flatMap((t) => (l.topics.has(t.id) ? [line(t.id, l.topics.get(t.id)!)] : [])),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
