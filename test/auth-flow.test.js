import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.JWT_SECRET_KEY = 'test-only-signing-key';
process.env.WEATHER_API_KEY = 'test-only-weather-key';
process.env.SENDGRID_API_KEY = 'test-only-sendgrid-key';
process.env.SENDGRID_FROM_EMAIL = 'test@example.com';
process.env.EMAIL_PROVIDER = 'sendgrid';
process.env.DEV_LOG_VERIFICATION_CODES = 'false';

const [{ default: User }, { default: sgMail }, { default: userRoute }, { errorHandler }, verification] = await Promise.all([
  import('../model/UserSchema.js'), import('@sendgrid/mail'),
  import('../routes/UserRoute.js'), import('../middleware/errorHandler.js'), import('../utils/verification.js'),
]);

const originals = {
  findOne: User.findOne,
  findById: User.findById,
  save: User.prototype.save,
  send: sgMail.send,
  setApiKey: sgMail.setApiKey,
};
const { default: AuthRateLimit } = await import('../model/AuthRateLimitSchema.js');
const originalCounter = AuthRateLimit.findOneAndUpdate;
const counters = new Map();
AuthRateLimit.findOneAndUpdate = async ({ _id }) => {
  const count = (counters.get(_id) || 0) + 1;
  counters.set(_id, count);
  return { count };
};
const users = new Map();
const emails = [];

User.findOne = async (query) => [...users.values()].find((user) =>
  Object.entries(query).every(([key, value]) => user[key] === value)) || null;
User.findById = (id) => {
  const user = [...users.values()].find((item) => item._id.toString() === String(id)) || null;
  return {
    select: async () => user,
    then: (resolve, reject) => Promise.resolve(user).then(resolve, reject),
  };
};
User.prototype.save = async function () { users.set(this.email, this); return this; };
sgMail.setApiKey = () => {};
sgMail.send = async (message) => { emails.push(message); return [{ statusCode: 202 }]; };

const app = express();
app.use(express.json());
app.use('/users', userRoute);
app.use(errorHandler);
const server = app.listen(0);
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const request = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  User.findOne = originals.findOne;
  User.findById = originals.findById;
  User.prototype.save = originals.save;
  sgMail.send = originals.send;
  sgMail.setApiKey = originals.setApiKey;
  AuthRateLimit.findOneAndUpdate = originalCounter;
});

test('verification and reset codes are emailed, limited, and invalidate old sessions', async () => {
  const identity = { firstName: 'Test', lastName: 'Fisher', email: 'fisher@example.com', contact: '+94771234567', password: 'Password123', boatId: '' };
  const registered = await request('/users/register', { method: 'POST', body: { ...identity, role: 'coastguard' } });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.data.user.role, 'fisherman');
  assert.equal(registered.body.data.token, undefined);
  assert.equal(registered.body.data.otp, undefined);
  assert.equal(emails.length, 1);
  const accountCode = /code is (\d{6})/.exec(emails[0].text)?.[1];
  assert.ok(accountCode);
  const user = users.get(identity.email);
  assert.equal(user.role, 'fisherman');
  assert.notEqual(user.verificationCodeHash, accountCode);
  assert.equal(user.otp, undefined);

  const inactiveLogin = await request('/users/login', { method: 'POST', body: { email: identity.email, password: identity.password } });
  assert.equal(inactiveLogin.status, 200);
  assert.equal(inactiveLogin.body.data.requiresVerification, true);
  assert.equal(inactiveLogin.body.data.token, undefined);
  assert.equal((await request('/users/resend-verification-otp', { method: 'POST', body: { username: user.username, email: user.email } })).status, 429);
  assert.equal((await request('/users/verify-otp', { method: 'POST', body: { username: user.username, otp: '000000' } })).status, 400);
  assert.equal(user.verificationAttempts, 1);

  const verified = await request('/users/verify-otp', { method: 'POST', body: { username: user.username, otp: accountCode } });
  assert.equal(verified.status, 200);
  const oldAccessToken = verified.body.data.token;
  assert.equal((await request('/users/profile', { token: oldAccessToken })).status, 200);

  const forgot = await request('/users/forgot-password', { method: 'POST', body: { email: user.email } });
  assert.equal(forgot.status, 200);
  assert.equal(forgot.body.data.otp, undefined);
  assert.equal((await request('/users/forgot-password', { method: 'POST', body: { email: 'missing@example.com' } })).status, 200);
  assert.equal(emails.length, 2);
  const resetCode = /code is (\d{6})/.exec(emails[1].text)?.[1];
  assert.ok(resetCode);
  const resetVerified = await request('/users/verify-reset-otp', { method: 'POST', body: { email: user.email, otp: resetCode } });
  assert.equal(resetVerified.status, 200);
  const resetToken = resetVerified.body.data.resetToken;
  assert.equal((await request('/users/profile', { token: resetToken })).status, 401);

  const reset = await request('/users/reset-password', { method: 'POST', body: { email: user.email, password: 'NewPassword123', resetToken } });
  assert.equal(reset.status, 200);
  assert.equal((await request('/users/profile', { token: oldAccessToken })).status, 401);
  assert.equal((await request('/users/reset-password', { method: 'POST', body: { email: user.email, password: 'AnotherPassword123', resetToken } })).status, 401);
  assert.equal((await request('/users/login', { method: 'POST', body: { email: user.email, password: identity.password } })).status, 401);
  assert.equal((await request('/users/login', { method: 'POST', body: { email: user.email, password: 'NewPassword123' } })).status, 200);
});

test('five wrong codes lock the current code window, including resends', async () => {
  const user = { _id: '507f1f77bcf86cd799439014', save: async () => {} };
  const code = verification.issueVerification(user, 'account');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(verification.verifyCode(user, 'account', '000000'), { statusCode: 400 });
  }
  user.verificationSentAt = new Date(Date.now() - 61_000);
  assert.throws(() => verification.issueVerification(user, 'account'), { statusCode: 429 });
  await assert.rejects(verification.verifyCode(user, 'account', code), { statusCode: 400 });
});

test('auth routes reject malformed and query-operator inputs before database lookup', async () => {
  let queries = 0;
  const lookup = User.findOne;
  User.findOne = async () => { queries++; throw new Error('Must not query'); };
  try {
    for (const [path, body] of [
      ['login', { email: { $ne: null }, password: 'Password123' }],
      ['LOGIN/', { email: { $ne: null }, password: 'Password123' }],
      ['login', { email: 'bad-email', password: 'Password123' }],
      ['login', { email: 'test@example.com', password: 'é'.repeat(37) }],
      ['verify-otp', { username: { $gt: '' }, otp: '123456' }],
      ['verify-reset-otp', { email: 'test@example.com', otp: 123456 }],
      ['forgot-password', { email: ['test@example.com'] }],
      ['resend-verification-otp', { username: 'test', email: { $ne: null } }],
      ['reset-password', { email: 'test@example.com', password: 'Password123', resetToken: {} }],
      ['register', { firstName: 'Test', lastName: 'Fisher', email: 'test@example.com', contact: {}, password: 'Password123' }],
    ]) {
      assert.equal((await request(`/users/${path}`, { method: 'POST', body })).status, 400, path);
    }
    assert.equal(queries, 0);
  } finally { User.findOne = lookup; }
});

test('codes expire, are purpose-bound and cannot be reused after successful verification', async () => {
  const user = { _id: '507f1f77bcf86cd799439015', save: async () => {} };
  const code = verification.issueVerification(user, 'account');
  await assert.rejects(verification.verifyCode(user, 'password-reset', code), { statusCode: 400 });
  user.verificationExpiresAt = new Date(Date.now() - 1);
  await assert.rejects(verification.verifyCode(user, 'account', code), { statusCode: 400 });
  user.verificationSentAt = new Date(Date.now() - 61_000);
  const replacement = verification.issueVerification(user, 'account');
  assert.equal(user.verificationAttempts, 0);
  await verification.verifyCode(user, 'account', replacement);
  await assert.rejects(verification.verifyCode(user, 'account', replacement), { statusCode: 400 });
});

test('login conceals whether the email or password was incorrect', async () => {
  const unknown = await request('/users/login', { method: 'POST', body: { email: 'unknown@example.com', password: 'Password123' } });
  const known = await request('/users/login', { method: 'POST', body: { email: 'fisher@example.com', password: 'Wrong123' } });
  assert.equal(unknown.status, 401);
  assert.equal(known.status, 401);
  assert.equal(unknown.body.message, known.body.message);
});

test('email delivery failure never returns a usable verification code', async () => {
  const send = sgMail.send;
  sgMail.send = async () => { throw new Error('Provider failure'); };
  try {
    const failed = await request('/users/register', { method: 'POST', body: {
      firstName: 'Test', lastName: 'Delivery', email: 'delivery@example.com', contact: '+94771234567', password: 'Password123',
    } });
    assert.equal(failed.status, 503);
    const user = users.get('delivery@example.com');
    assert.equal(user.isActive, false);
    assert.equal(user.verificationCodeHash, undefined);
  } finally { sgMail.send = send; }
});

test('expired access tokens and wrong signing algorithms cannot restore sessions', async () => {
  const { default: jwt } = await import('jsonwebtoken');
  const user = users.get('fisher@example.com');
  const payload = { userId: user._id, purpose: 'access', authVersion: user.authVersion };
  const expired = jwt.sign(payload, process.env.JWT_SECRET_KEY, { expiresIn: -1 });
  const wrongAlgorithm = jwt.sign(payload, process.env.JWT_SECRET_KEY, { algorithm: 'HS384' });
  assert.equal((await request('/users/profile', { token: expired })).status, 401);
  assert.equal((await request('/users/profile', { token: wrongAlgorithm })).status, 401);
});
