/**
 * A5 review topics. Our own product choices (no externally owned facts here).
 *
 * To add a topic: append one entry to REVIEW_TOPICS (a short snake_case id and a plain label). Nothing
 * else changes: the prompt, the validation, the filter and the trends read this list. Reviews already
 * classified keep their stored topics and do not count the new topic until they are classified again
 * (an unchanged review is never classified twice, so reclassify by clearing its row on purpose).
 * Never rename or remove an id that is already stored: stored rows would stop matching it.
 */
export const REVIEW_TOPICS = [
  { id: "staff", label: "Staff", hint: "friendliness, attitude, professionalism of the people" },
  { id: "wait_time", label: "Wait time", hint: "waiting, delays, speed of service" },
  { id: "price_value", label: "Price and value", hint: "cost, fees, billing, value for money" },
  { id: "cleanliness", label: "Cleanliness", hint: "how clean, tidy and comfortable the place is" },
  { id: "results_quality", label: "Results and quality", hint: "quality of the work, food, treatment or outcome" },
  { id: "communication", label: "Communication", hint: "explanations, listening, follow-up, responsiveness" },
  { id: "booking", label: "Booking and scheduling", hint: "appointments, reservations, availability" },
  { id: "location_parking", label: "Location and parking", hint: "access, parking, the building, finding the place" },
  { id: "other", label: "Other", hint: "anything that fits none of the above" },
] as const;

export type ReviewTopicId = (typeof REVIEW_TOPICS)[number]["id"];
export const REVIEW_TOPIC_IDS = REVIEW_TOPICS.map((t) => t.id) as [ReviewTopicId, ...ReviewTopicId[]];

export const TOPIC_SENTIMENTS = ["positive", "negative", "mixed"] as const;
export type TopicSentiment = (typeof TOPIC_SENTIMENTS)[number];

export const REVIEW_TOPIC_CONFIG = {
  /** Reviews per model call. */
  batchSize: 20,
  /** Characters of one review sent to the model (the rest is cut). Keeps a batch far below the long-prompt price tier. */
  maxCharsPerReview: 1_500,
  /** Output ceiling per review in a call; the call's ceiling is this times its reviews, plus a little. */
  outputTokensPerReview: 120,
  /** Most reviews one run (a button press, or one client in the daily sweep) classifies; the rest wait. */
  maxPerRun: 200,
  /** Weeks the trends cover, counted back from the current UTC week (Monday start). */
  trendWeeks: 12,
  /** Daily sweep for clients that turned automatic classification on. */
  sweepCron: "20 4 * * *",
} as const;
