/**
 * Pub/Sub push envelopes for Business Profile notifications, with fake ids.
 * Envelope shape: https://docs.cloud.google.com/pubsub/docs/push
 * Notification fields (notificationType, locationName, reviewName):
 *   https://developers.google.com/my-business/reference/rest/v4/Notifications
 * `NEW_REVIEW_OBSERVED_SHAPE` uses the {type, location, review} spelling one third party reports
 * seeing from Google's live pushes; see packages/core/src/pubsub/notification.ts.
 */
export const FIXTURE_ACCOUNT = "accounts/100000000000000000001";
export const FIXTURE_LOCATION = "locations/200000000000000000002";
export const FIXTURE_LOCATION_FULL = `${FIXTURE_ACCOUNT}/${FIXTURE_LOCATION}`;

export type PushEnvelope = {
  message: {
    data: string;
    attributes: Record<string, string>;
    messageId: string;
    publishTime: string;
  };
  subscription: string;
};

export function pushEnvelope(payload: unknown, messageId: string): PushEnvelope {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString("base64"),
      attributes: {},
      messageId,
      publishTime: "2026-10-12T09:30:00.123Z",
    },
    subscription: "projects/syngmb-fake/subscriptions/gbp-notifications-push",
  };
}

export const newReview = (messageId = "7000000000000001", location = FIXTURE_LOCATION_FULL) =>
  pushEnvelope(
    {
      notificationType: "NEW_REVIEW",
      locationName: location,
      reviewName: `${location.replace(/^accounts\/\d+\//, `${FIXTURE_ACCOUNT}/`)}/reviews/AbFakeReviewId1`,
    },
    messageId,
  );

export const updatedReview = (messageId = "7000000000000002", location = FIXTURE_LOCATION_FULL) =>
  pushEnvelope(
    {
      notificationType: "UPDATED_REVIEW",
      locationName: location,
      reviewName: `${location}/reviews/AbFakeReviewId2`,
    },
    messageId,
  );

export const googleUpdate = (messageId = "7000000000000003", location = FIXTURE_LOCATION_FULL) =>
  pushEnvelope({ notificationType: "GOOGLE_UPDATE", locationName: location }, messageId);

export const newReviewObservedShape = (messageId = "7000000000000004") =>
  pushEnvelope(
    {
      type: "NEW_REVIEW",
      location: FIXTURE_LOCATION_FULL,
      review: `${FIXTURE_LOCATION_FULL}/reviews/AbFakeReviewId3`,
    },
    messageId,
  );
