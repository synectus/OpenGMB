import { describe, expect, it } from "vitest";
import { parseSentiment, parseTopic, topicRows, type TopicInput } from "./review-topics";

const w = (total: number, negative: number, positive = total - negative): { total: number; positive: number; negative: number; mixed: number } => ({
  total,
  negative,
  positive,
  mixed: total - negative - positive,
});
const topic = (id: TopicInput["topic"], weekly: ReturnType<typeof w>[]): TopicInput => {
  const sum = (k: "total" | "positive" | "negative" | "mixed") => weekly.reduce((n, x) => n + x[k], 0);
  return { topic: id, total: sum("total"), positive: sum("positive"), negative: sum("negative"), mixed: sum("mixed"), weekly };
};
const zeros = (n: number) => Array.from({ length: n }, () => w(0, 0));

describe("topicRows", () => {
  it("drops topics with no mentions and sorts by mentions", () => {
    const rows = topicRows([topic("staff", [w(2, 0), ...zeros(11)]), topic("cleanliness", zeros(12)), topic("wait_time", [w(5, 5), ...zeros(11)])]);
    expect(rows.map((r) => [r.topic, r.total])).toEqual([["wait_time", 5], ["staff", 2]]);
  });
  it("percents add up to 100 and the weekly negative share is null in an empty week", () => {
    const [r] = topicRows([topic("staff", [w(3, 1, 1), ...zeros(11)])]); // 1 positive, 1 negative, 1 mixed
    expect(r!.pct).toEqual({ positive: 33, negative: 33, mixed: 34 });
    expect(r!.weeklyNegative.slice(0, 2)).toEqual([1 / 3, null]);
  });
  it("calls a trend only with enough mentions on both sides", () => {
    const rising = [...Array.from({ length: 8 }, () => w(1, 0)), ...Array.from({ length: 4 }, () => w(1, 1))];
    const falling = [...Array.from({ length: 8 }, () => w(1, 1)), ...Array.from({ length: 4 }, () => w(1, 0))];
    const steady = Array.from({ length: 12 }, () => w(1, 0));
    const few = [w(1, 0), ...zeros(10), w(1, 1)];
    const [a, b, c, d] = topicRows([topic("staff", rising), topic("wait_time", falling), topic("price_value", steady), topic("other", few)]).sort((x, y) => x.topic.localeCompare(y.topic));
    expect([a!.topic, a!.trend]).toEqual(["other", "none"]);
    expect([b!.topic, b!.trend]).toEqual(["price_value", "flat"]);
    expect([c!.topic, c!.trend]).toEqual(["staff", "up"]);
    expect([d!.topic, d!.trend]).toEqual(["wait_time", "down"]);
  });
});

describe("filter params", () => {
  it("accepts known topics and sentiments only", () => {
    expect(parseTopic("wait_time")).toBe("wait_time");
    expect(parseTopic("weather")).toBeUndefined();
    expect(parseTopic(undefined)).toBeUndefined();
    expect(parseSentiment("mixed")).toBe("mixed");
    expect(parseSentiment("angry")).toBeUndefined();
  });
});
