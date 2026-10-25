'use strict';

const { verifySignature } = require('../lib/signature');
const { callAction, baseUrl } = require('../lib/api');

const performSubscribe = async (z, bundle) => {
  const input = {
    url: bundle.targetUrl,
    events: ['review.created'],
    description: 'Zapier',
  };
  if (bundle.inputData && bundle.inputData.workspaceId) input.workspaceId = bundle.inputData.workspaceId;
  const out = await callAction(z, 'webhooks.subscribe', input);
  // Stored by Zapier as bundle.subscribeData. The secret lets perform verify signatures.
  return { id: out.subscription.id, secret: out.secret };
};

const performUnsubscribe = async (z, bundle) => {
  await callAction(z, 'webhooks.unsubscribe', { id: bundle.subscribeData.id });
  return {};
};

const perform = async (z, bundle) => {
  const secret = bundle.subscribeData && bundle.subscribeData.secret;
  if (secret) {
    const raw = bundle.rawRequest || {};
    if (!verifySignature({ secret, headers: raw.headers, content: raw.content })) {
      throw new z.errors.HaltedError('OpenGMB webhook signature did not verify; ignoring this request.');
    }
  }
  const req = bundle.cleanedRequest || {};
  const review = req.data && req.data.review;
  if (!review) return [];
  // Test events pass through (editor "Test trigger" and webhooks.sendTest); users can filter on `test`.
  return [{ ...review, test: Boolean(req.test) }];
};

const performList = async (z, bundle) => {
  const workspaceId = bundle.inputData && bundle.inputData.workspaceId;
  const input = { limit: 3 };
  if (workspaceId) input.workspaceId = workspaceId;
  const out = await callAction(z, 'reviews.list', input);
  let workspaceName = null;
  if (workspaceId) {
    const ws = await callAction(z, 'workspaces.list', {});
    const hit = ws.workspaces.find((w) => w.id === workspaceId);
    workspaceName = hit ? hit.name : null;
  }
  return out.items.map((r) => ({
    id: r.id,
    workspaceId: workspaceId || null,
    workspaceName,
    locationId: r.location.id,
    locationName: r.location.name,
    googleReviewName: r.googleReviewName,
    starRating: r.rating,
    comment: r.comment,
    reviewerName: r.reviewer.isAnonymous ? null : r.reviewer.displayName,
    createTime: r.createTime,
    updateTime: r.updateTime,
    appUrl: `${baseUrl()}/reviews?review=${r.id}`,
    test: false,
  }));
};

module.exports = {
  key: 'new_review',
  noun: 'Review',
  display: {
    label: 'New Review',
    description: 'Triggers when a new Google review arrives for one of your locations.',
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'workspaceId',
        label: 'Client',
        required: false,
        dynamic: 'workspaces.id.name',
        helpText: 'Leave empty to receive reviews for every client.',
      },
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: {
      id: '5b0f6a1e-6b8e-4c1a-9a53-0d6c2c1f0a01',
      workspaceId: '00000000-0000-4000-8000-000000000001',
      workspaceName: 'Sample client',
      locationId: '00000000-0000-4000-8000-000000000002',
      locationName: 'Sample location',
      googleReviewName: 'accounts/1/locations/2/reviews/sample',
      starRating: 5,
      comment: 'Great service, thank you!',
      reviewerName: 'Sample reviewer',
      createTime: '2026-10-24T00:00:00.000Z',
      updateTime: '2026-10-24T00:00:00.000Z',
      appUrl: 'https://opengmb.example.com/reviews?review=5b0f6a1e-6b8e-4c1a-9a53-0d6c2c1f0a01',
      test: false,
    },
    outputFields: [
      { key: 'id', label: 'Review ID' },
      { key: 'workspaceName', label: 'Client' },
      { key: 'locationName', label: 'Location' },
      { key: 'starRating', label: 'Star rating', type: 'integer' },
      { key: 'comment', label: 'Comment' },
      { key: 'reviewerName', label: 'Reviewer' },
      { key: 'createTime', label: 'Created' },
      { key: 'appUrl', label: 'Open in OpenGMB' },
      { key: 'test', label: 'Is test event', type: 'boolean' },
    ],
  },
};
