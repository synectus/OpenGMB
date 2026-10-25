'use strict';

const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;

// Standard Webhooks: signature = "v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>",
// key = base64 part of the secret after "whsec_".
const verifySignature = ({ secret, headers, content, nowSeconds }) => {
  const h = {};
  // Zapier passes hook request headers in bundle.rawRequest with an "Http-" prefix (Http-Webhook-Id).
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase().replace(/^http-/, '')] = v;
  const id = h['webhook-id'];
  const ts = Number(h['webhook-timestamp']);
  const sig = h['webhook-signature'];
  if (!id || !ts || !sig) return false;
  if (Math.abs((nowSeconds || Math.floor(Date.now() / 1000)) - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(
    'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${content}`).digest('base64')
  );
  return sig.split(' ').some((c) => {
    const got = Buffer.from(c);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
};

module.exports = { verifySignature };
