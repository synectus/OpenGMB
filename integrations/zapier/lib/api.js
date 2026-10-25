'use strict';

const { defaultBaseUrl } = require('./base-url');

// The address of the OpenGMB server. SYNGMB_BASE_URL sets it (tests, staging, and every self-hosted server).
const baseUrl = () => {
  const url = process.env.SYNGMB_BASE_URL || defaultBaseUrl();
  if (!url) {
    throw new Error('SYNGMB_BASE_URL is not set. Set it to the address of your OpenGMB server, for example https://opengmb.example.com');
  }
  return url.replace(/\/+$/, '');
};

// POST {base}/api/v1/actions/<name>. Success is { data }, errors are { error: { code, message } }.
// A 401 is turned into Zapier's expired-auth error by the afterResponse middleware in index.js.
const callAction = async (z, name, input = {}) => {
  const response = await z.request({
    method: 'POST',
    url: `${baseUrl()}/api/v1/actions/${name}`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: input,
    skipThrowForStatus: true,
  });
  if (response.status >= 400) {
    const err = response.data && response.data.error;
    throw new z.errors.Error(
      (err && err.message) || `OpenGMB API returned HTTP ${response.status}`,
      (err && err.code) || 'API_ERROR',
      response.status
    );
  }
  return response.data.data;
};

module.exports = { callAction, baseUrl };
