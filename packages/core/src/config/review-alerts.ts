/**
 * Our own product choice, not a Google number: a sync does not raise negative-review alerts for
 * reviews Google created more than this many days ago, so importing a location's history does not
 * flood its recipients. Pub/Sub intake is a live event and ignores it.
 */
export const NEGATIVE_ALERT_MAX_AGE_DAYS = 14;

/**
 * Our own product choice, not a Google number: a review rated this or lower is "negative" (it
 * raises the review.negative alert and is the first bucket on Home). Copy reads "1 to N★".
 */
export const NEGATIVE_REVIEW_MAX_STARS = 3;
