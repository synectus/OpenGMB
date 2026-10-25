'use strict';

const { callAction } = require('../lib/api');

// Hidden helper trigger: feeds the optional "Client" dropdown on New Review.
module.exports = {
  key: 'workspaces',
  noun: 'Client',
  display: { label: 'Client', description: 'Lists your clients.', hidden: true },
  operation: {
    perform: async (z) => {
      const out = await callAction(z, 'workspaces.list', {});
      return out.workspaces.map((w) => ({ id: w.id, name: w.name }));
    },
    sample: { id: '00000000-0000-4000-8000-000000000001', name: 'Sample client' },
  },
};
