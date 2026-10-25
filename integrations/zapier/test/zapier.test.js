'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nock = require('nock').default;
const zapier = require('zapier-platform-core');

process.env.SYNGMB_BASE_URL = 'https://syngmb.test';
const BASE = 'https://syngmb.test';
const App = require('../index');
const { verifySignature } = require('../lib/signature');
const appTester = zapier.createAppTester(App);
zapier.tools.env.inject();

const TOKEN = 'sgmb_testtoken';
const authData = { apiToken: TOKEN };
const fixture = require('./fixtures/review-created.json');
const snapshot = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../apps/mcp/src/__snapshots__/rest-v1-contract.json'), 'utf8')
);
const frozenReviewKeys = Object.keys(snapshot['review.created payload'].properties.data.properties.review.properties);

const api = () => nock(BASE, { reqheaders: { authorization: `Bearer ${TOKEN}` } });

describe('OpenGMB Zapier integration', () => {
  before(() => nock.disableNetConnect());
  afterEach(() => {
    assert.deepStrictEqual(nock.pendingMocks(), [], 'every mocked call must be used');
    nock.cleanAll();
  });
  after(() => nock.enableNetConnect());

  describe('contract canary', () => {
    it('the fixture has exactly the frozen review.created key set (and the snapshot was read)', () => {
      assert.ok(frozenReviewKeys.length >= 10, `read ${frozenReviewKeys.length} frozen keys`);
      assert.deepStrictEqual(Object.keys(fixture.data.review).sort(), [...frozenReviewKeys].sort());
    });
    it('the trigger sample has the frozen keys plus test', () => {
      const sample = App.triggers.new_review.operation.sample;
      assert.deepStrictEqual(Object.keys(sample).sort(), [...frozenReviewKeys, 'test'].sort());
    });
  });

  describe('authentication', () => {
    it('test calls apiTokens.current with the bearer token', async () => {
      api().post('/api/v1/actions/apiTokens.current', {}).reply(200, {
        data: { organization: { id: 'o1', name: 'Acme' }, user: { email: 'a@acme.test' }, role: 'owner', token: null },
      });
      const res = await appTester(App.authentication.test, { authData });
      assert.strictEqual(res.organization.name, 'Acme');
    });
    it('connection label renders "{org} ({email})"', () => {
      const label = App.authentication.connectionLabel
        .replace('{{organization.name}}', 'Acme')
        .replace('{{user.email}}', 'a@acme.test');
      assert.strictEqual(label, 'Acme (a@acme.test)');
    });
    it('a 401 becomes the expired-auth error', async () => {
      api().post('/api/v1/actions/apiTokens.current').reply(401, { error: { code: 'UNAUTHENTICATED', message: 'bad' } });
      await assert.rejects(appTester(App.authentication.test, { authData }), /ExpiredAuthError|rejected/);
    });
    it('other errors surface the API message', async () => {
      api().post('/api/v1/actions/apiTokens.current').reply(503, { error: { code: 'NOT_CONFIGURED', message: 'Webhooks are off' } });
      await assert.rejects(appTester(App.authentication.test, { authData }), /Webhooks are off/);
    });
  });

  describe('new_review hook', () => {
    const op = App.triggers.new_review.operation;

    it('performSubscribe posts webhooks.subscribe and keeps id and secret', async () => {
      api()
        .post('/api/v1/actions/webhooks.subscribe', {
          url: 'https://hooks.zapier.com/hooks/standard/1/abc/',
          events: ['review.created'],
          description: 'Zapier',
        })
        .reply(200, { data: { subscription: { id: 'sub1' }, secret: 'whsec_AAAA' } });
      const res = await appTester(op.performSubscribe, {
        authData,
        targetUrl: 'https://hooks.zapier.com/hooks/standard/1/abc/',
        inputData: {},
      });
      assert.deepStrictEqual(res, { id: 'sub1', secret: 'whsec_AAAA' });
    });

    it('performSubscribe passes the optional workspaceId', async () => {
      api()
        .post('/api/v1/actions/webhooks.subscribe', (b) => b.workspaceId === 'w1' && b.url === 'https://t/')
        .reply(200, { data: { subscription: { id: 'sub2' }, secret: 'whsec_B' } });
      const res = await appTester(op.performSubscribe, { authData, targetUrl: 'https://t/', inputData: { workspaceId: 'w1' } });
      assert.strictEqual(res.id, 'sub2');
    });

    it('performUnsubscribe posts webhooks.unsubscribe with subscribeData.id', async () => {
      api().post('/api/v1/actions/webhooks.unsubscribe', { id: 'sub1' }).reply(200, { data: { ok: true } });
      await appTester(op.performUnsubscribe, { authData, subscribeData: { id: 'sub1', secret: 'x' } });
    });

    it('perform flattens the review and passes the test flag through', async () => {
      const live = await appTester(op.perform, { authData, cleanedRequest: fixture });
      assert.deepStrictEqual(live, [{ ...fixture.data.review, test: false }]);
      const test = await appTester(op.perform, { authData, cleanedRequest: { ...fixture, test: true } });
      assert.strictEqual(test[0].test, true);
    });

    it('perform returns nothing for a body without a review', async () => {
      assert.deepStrictEqual(await appTester(op.perform, { authData, cleanedRequest: {} }), []);
    });

    describe('signature verification', () => {
      const secret = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
      const content = JSON.stringify(fixture);
      const ts = Math.floor(Date.now() / 1000);
      const sign = (body, id = 'msg_1', t = ts) =>
        'v1,' +
        crypto
          .createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
          .update(`${id}.${t}.${body}`)
          .digest('base64');
      const headers = (over = {}) => ({
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(ts),
        'webhook-signature': sign(content),
        ...over,
      });

      it('accepts a valid signature (canary: verifier says true for a known-good message)', () => {
        assert.strictEqual(verifySignature({ secret, headers: headers(), content }), true);
      });
      it('accepts the Http- prefixed header names Zapier passes in bundle.rawRequest', () => {
        // Seen in production on 2026-10-24: Zapier delivers Http-Webhook-Id, Http-Webhook-Timestamp and
        // Http-Webhook-Signature, so every real delivery halted until the prefix was stripped.
        const zapierHeaders = {
          'Http-Webhook-Id': 'msg_1',
          'Http-Webhook-Timestamp': String(ts),
          'Http-Webhook-Signature': sign(content),
          'Http-Content-Type': 'application/json',
        };
        assert.strictEqual(verifySignature({ secret, headers: zapierHeaders, content }), true);
        assert.strictEqual(verifySignature({ secret, headers: zapierHeaders, content: content + ' ' }), false);
      });
      it('rejects a tampered body, a wrong signature and a stale timestamp', () => {
        assert.strictEqual(verifySignature({ secret, headers: headers(), content: content + ' ' }), false);
        assert.strictEqual(verifySignature({ secret, headers: headers({ 'webhook-signature': 'v1,AAAA' }), content }), false);
        const old = ts - 3600;
        assert.strictEqual(
          verifySignature({ secret, headers: headers({ 'webhook-timestamp': String(old), 'webhook-signature': sign(content, 'msg_1', old) }), content }),
          false
        );
      });
      it('perform accepts a signed request and halts on a bad one when the secret is known', async () => {
        const ok = await appTester(op.perform, {
          authData,
          subscribeData: { id: 's', secret },
          rawRequest: { headers: headers(), content },
          cleanedRequest: fixture,
        });
        assert.strictEqual(ok.length, 1);
        await assert.rejects(
          appTester(op.perform, {
            authData,
            subscribeData: { id: 's', secret },
            rawRequest: { headers: headers({ 'webhook-signature': 'v1,AAAA' }), content },
            cleanedRequest: fixture,
          }),
          /signature did not verify/
        );
      });
    });

    it('performList maps reviews.list to exactly the review.created key set', async () => {
      api()
        .post('/api/v1/actions/reviews.list', { limit: 3 })
        .reply(200, {
          data: {
            items: [
              {
                id: fixture.data.review.id,
                replyStage: 'needs_reply',
                googleReviewName: fixture.data.review.googleReviewName,
                location: { id: fixture.data.review.locationId, name: fixture.data.review.locationName },
                reviewer: { displayName: 'Sam', isAnonymous: false },
                rating: 2,
                comment: 'Long wait.',
                createTime: fixture.data.review.createTime,
                updateTime: fixture.data.review.updateTime,
                reply: null,
              },
            ],
            nextCursor: null,
          },
        });
      const res = await appTester(op.performList, { authData, inputData: {} });
      assert.strictEqual(res.length, 1);
      const { test, workspaceId, workspaceName, ...rest } = res[0];
      assert.strictEqual(test, false);
      assert.deepStrictEqual(Object.keys(res[0]).sort(), [...frozenReviewKeys, 'test'].sort());
      assert.strictEqual(workspaceId, null);
      assert.strictEqual(workspaceName, null);
      const { workspaceId: _a, workspaceName: _b, ...expected } = fixture.data.review;
      assert.deepStrictEqual(rest, { ...expected, appUrl: `${BASE}/reviews?review=${expected.id}` });
    });

    it('performList with a chosen client fills workspace id and name', async () => {
      api().post('/api/v1/actions/reviews.list', { limit: 3, workspaceId: 'w1' }).reply(200, {
        data: {
          items: [{
            id: 'r1', replyStage: 'needs_reply', googleReviewName: 'g', location: { id: 'l', name: 'L' },
            reviewer: { displayName: null, isAnonymous: true }, rating: null, comment: null,
            createTime: 't', updateTime: 't', reply: null,
          }],
          nextCursor: null,
        },
      });
      api().post('/api/v1/actions/workspaces.list', {}).reply(200, { data: { workspaces: [{ id: 'w1', name: 'Acme' }] } });
      const [r] = await appTester(op.performList, { authData, inputData: { workspaceId: 'w1' } });
      assert.strictEqual(r.workspaceId, 'w1');
      assert.strictEqual(r.workspaceName, 'Acme');
      assert.strictEqual(r.reviewerName, null);
    });
  });

  describe('workspaces dropdown trigger', () => {
    it('is hidden and lists id/name from workspaces.list', async () => {
      assert.strictEqual(App.triggers.workspaces.display.hidden, true);
      api().post('/api/v1/actions/workspaces.list', {}).reply(200, {
        data: { workspaces: [{ id: 'w1', name: 'Acme', timeZone: 'UTC' }, { id: 'w2', name: 'Beta' }] },
      });
      const res = await appTester(App.triggers.workspaces.operation.perform, { authData });
      assert.deepStrictEqual(res, [{ id: 'w1', name: 'Acme' }, { id: 'w2', name: 'Beta' }]);
    });
  });

  describe('base URL', () => {
    it('uses SYNGMB_BASE_URL and drops trailing slashes', () => {
      const saved = process.env.SYNGMB_BASE_URL;
      process.env.SYNGMB_BASE_URL = 'https://opengmb.example.test//';
      try {
        assert.strictEqual(require('../lib/api').baseUrl(), 'https://opengmb.example.test');
      } finally {
        process.env.SYNGMB_BASE_URL = saved;
      }
    });
  });
});
