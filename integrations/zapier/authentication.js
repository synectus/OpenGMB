'use strict';

const { callAction } = require('./lib/api');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiToken',
      label: 'API token',
      type: 'password',
      required: true,
      helpText:
        'In OpenGMB open Settings > API tokens and create an owner token. It starts with `sgmb_`. Paste it here.',
    },
  ],
  test: (z) => callAction(z, 'apiTokens.current', {}),
  // test() returns { organization: { name }, user: { email }, ... }
  connectionLabel: '{{organization.name}} ({{user.email}})',
};
