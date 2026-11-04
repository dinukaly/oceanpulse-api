import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET_KEY = 'test-only-email-key';
process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 're_test_only';
process.env.RESEND_FROM_EMAIL = 'OceanPulse <noreply@example.test>';
process.env.DEV_LOG_VERIFICATION_CODES = 'false';
const { config } = await import('../config/env.js');
const { sendVerificationEmail } = await import('../services/verificationEmail.js');
const originalPost = axios.post;
after(() => { axios.post = originalPost; });

test('Resend receives account and reset messages with server-only credentials and bounded delivery', async () => {
  const calls = [];
  axios.post = async (...args) => { calls.push(args); return { data: { id: 'email-id' } }; };
  await sendVerificationEmail('recipient@example.test', '123456', 'account');
  await sendVerificationEmail('recipient@example.test', '654321', 'password-reset');
  assert.equal(calls.length, 2);
  const [url, message, options] = calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.deepEqual(message.to, ['recipient@example.test']);
  assert.equal(message.from, config.resendFromEmail);
  assert.equal(message.subject, 'Verify your OceanPulse account');
  assert.match(message.text, /123456/);
  assert.equal(options.headers.Authorization, 'Bearer re_test_only');
  assert.equal(options.timeout, 10000);
  assert.equal(options.maxRedirects, 0);
  assert.equal(calls[1][1].subject, 'Reset your OceanPulse password');
});

test('provider rejection, timeout and malformed acceptance become generic delivery errors', async () => {
  for (const outcome of ['rejection', 'timeout', 'missing-id']) {
    axios.post = async () => {
      if (outcome !== 'missing-id') throw new Error(`PRIVATE_PROVIDER_DETAILS ${outcome}`);
      return { data: {} };
    };
    await assert.rejects(sendVerificationEmail('recipient@example.test', '123456', 'account'),
      { statusCode: 503, message: 'Verification email could not be delivered' });
  }
});

test('missing Resend credentials fail before any network request', async () => {
  const key = config.resendApiKey;
  let requests = 0;
  axios.post = async () => { requests++; };
  try {
    config.resendApiKey = undefined;
    await assert.rejects(sendVerificationEmail('recipient@example.test', '123456', 'account'),
      { statusCode: 503, message: 'Verification email is not configured' });
    assert.equal(requests, 0);
  } finally { config.resendApiKey = key; }
});
