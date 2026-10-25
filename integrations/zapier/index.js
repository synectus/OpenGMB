'use strict';

const { version } = require('./package.json');
const { version: platformVersion } = require('zapier-platform-core');
const authentication = require('./authentication');
const newReview = require('./triggers/new_review');
const workspaces = require('./triggers/workspaces');

const addAuthHeader = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.apiToken) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.apiToken}`;
  }
  return request;
};

const handle401 = (response, z) => {
  if (response.status === 401) {
    throw new z.errors.ExpiredAuthError('Your OpenGMB API token was rejected. Reconnect with a valid token.');
  }
  return response;
};

const newReviewDef = newReview;

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addAuthHeader],
  afterResponse: [handle401],
  triggers: {
    [newReviewDef.key]: newReviewDef,
    [workspaces.key]: workspaces,
  },
};
