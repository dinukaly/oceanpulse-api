import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseEnvironment } from '../config/validation.js';
import { createLogger } from '../utils/logger.js';
import { createHealth } from '../services/health.js';
import { WebSocket } from 'ws';

process.env.JWT_SECRET_KEY = 'test-only-operations-key';
process.env.NODE_ENV = 'test';
process.env.DEV_LOG_VERIFICATION_CODES = 'false';
const { createApp, originAllowed } = await import('../app.js');
const { attachMessageSocket } = await import('../realtime/messageSocket.js');
const defaults = () => ({ NODE_ENV: 'test', JWT_SECRET_KEY: 'test-only-key' });
const production = () => ({
  NODE_ENV: 'production',
  JWT_SECRET_KEY: 'x'.repeat(64),
  MONGODB_URI: 'mongodb://127.0.0.1:27017/isolated',
  CORS_ALLOWED_ORIGINS: 'https://web.example.test',
});

async function appHarness({
  connected = () => true,
  ping = async () => {},
  env = defaults(),
} = {}) {
  const records = [];
  const logger = createLogger({
    write: (line) => records.push(JSON.parse(line)),
  });
  const settings = parseEnvironment(env);
  const health = createHealth({ connected, ping, timeoutMs: 50 });
  const app = createApp({ settings, health, logger });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    app,
    server,
    records,
    settings,
    health,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('production configuration fails closed and never echoes supplied credentials', () => {
  for (const change of [
    { JWT_SECRET_KEY: '' },
    { JWT_SECRET_KEY: 'short' },
    { MONGODB_URI: '' },
    { CORS_ALLOWED_ORIGINS: '' },
    { CORS_ALLOWED_ORIGINS: '*' },
    { CORS_ALLOWED_ORIGINS: 'https://*.example.test' },
    { CORS_ALLOWED_ORIGINS: 'https://user:private@example.test' },
    { CORS_ALLOWED_ORIGINS: 'https://web.example.test/path' },
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '1' },
    { TRUST_PROXY: '0.0.0.0/0' },
    { TRUST_PROXY: '127.0.0.1/999' },
    { PORT: '0' },
    { PORT: '3000junk' },
    { LOG_LEVEL: 'debug-with-private-details' },
    { READINESS_TIMEOUT_MS: '-1' },
    { SENDGRID_API_KEY: 'PRIVATE_SENTINEL' },
    { EMAIL_PROVIDER: 'unknown' },
    { RESEND_API_KEY: 'PRIVATE_SENTINEL' },
    { DEV_LOG_VERIFICATION_CODES: 'true' },
    { DEV_LOG_VERIFICATION_CODES: 'maybe' },
  ]) {
    assert.throws(
      () => parseEnvironment({ ...production(), ...change }),
      (error) =>
        error.name === 'ConfigurationError' &&
        !error.message.includes('PRIVATE_SENTINEL'),
    );
  }
  const parsed = parseEnvironment({
    ...production(),
    TRUST_PROXY: 'loopback,192.0.2.0/24',
    CORS_ALLOWED_ORIGINS: 'https://web.example.test/,https://web.example.test',
  });
  assert.deepEqual(parsed.corsOrigins, ['https://web.example.test']);
  assert.deepEqual(parsed.trustProxy, ['loopback', '192.0.2.0/24']);
  assert.equal(parsed.autoIndex, false);
  assert.equal(parseEnvironment(defaults()).trustProxy, false);
  assert.equal(parseEnvironment(defaults()).devLogVerificationCodes, false);
  assert.equal(
    parseEnvironment({
      NODE_ENV: 'development',
      JWT_SECRET_KEY: 'local-key',
      DEV_LOG_VERIFICATION_CODES: 'true',
    }).devLogVerificationCodes,
    true,
  );
  const nativeOnly = parseEnvironment({
    ...production(),
    CORS_ALLOWED_ORIGINS: 'none',
  });
  assert.deepEqual(nativeOnly.corsOrigins, []);
  assert.equal(originAllowed(nativeOnly, undefined), true);
  assert.equal(originAllowed(nativeOnly, 'https://web.example.test'), false);
});

test('structured logger only emits approved fields and survives a broken output sink', () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  logger.error('request.failed', {
    errorKind: 'unexpected',
    headers: { authorization: 'PRIVATE_SENTINEL' },
    body: { password: 'PRIVATE_SENTINEL' },
    message: 'PRIVATE_SENTINEL',
    stack: 'PRIVATE_SENTINEL',
    url: '/?token=PRIVATE_SENTINEL',
    reason: 'PRIVATE_SENTINEL',
    requestId: 'PRIVATE_SENTINEL',
  });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('PRIVATE_SENTINEL'));
  assert.equal(JSON.parse(lines[0]).errorKind, 'unexpected');
  createLogger({
    write: () => {
      throw new Error('sink failure');
    },
  }).error('request.failed');
  const quiet = createLogger({
    level: 'error',
    write: (line) => lines.push(line),
  });
  quiet.info('server.started');
  assert.equal(lines.length, 1);
});

test('liveness is independent of MongoDB; readiness gates startup, connectivity, ping and draining', async () => {
  let connected = true;
  let fail = false;
  const harness = await appHarness({
    connected: () => connected,
    ping: async () => {
      if (fail) throw new Error('PRIVATE_SENTINEL');
    },
  });
  try {
    const get = (path) => fetch(harness.base + path);
    assert.equal((await get('/api/v1/health/live')).status, 200);
    assert.equal((await get('/api/v1/health/ready')).status, 503);
    harness.health.state.initialized = true;
    const ready = await get('/api/v1/health/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    assert.equal(ready.headers.get('x-powered-by'), null);
    connected = false;
    assert.equal((await get('/api/v1/health/ready')).status, 503);
    assert.equal((await get('/api/v1/health/live')).status, 200);
    connected = true;
    fail = true;
    const failed = await get('/api/v1/health/ready');
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes('PRIVATE_SENTINEL'));
    fail = false;
    harness.health.state.draining = true;
    assert.equal((await get('/api/v1/health/ready')).status, 503);
    assert.equal((await get('/api/v1/users/profile')).status, 503);
    assert.equal((await get('/api/v1/health/live')).status, 200);
  } finally {
    await harness.close();
  }
});

test('a stuck readiness probe has a bounded response and only one underlying operation', async () => {
  let calls = 0,
    finish;
  const harness = await appHarness({
    ping: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  harness.health.state.initialized = true;
  try {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(harness.base + '/api/v1/health/ready'),
      ),
    );
    assert.ok(responses.every((response) => response.status === 503));
    assert.equal(calls, 1);
    assert.equal(
      (await fetch(harness.base + '/api/v1/health/ready')).status,
      503,
    );
    assert.equal(calls, 1);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally {
    finish?.();
    await harness.close();
  }
});

test('HTTP CORS permits exact configured origins and native requests while rejecting unrelated origins', async () => {
  const harness = await appHarness({ env: production() });
  try {
    const response = await fetch(harness.base + '/api/v1/health/live', {
      headers: { Origin: 'https://web.example.test' },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      'https://web.example.test',
    );
    assert.match(
      response.headers.get('access-control-expose-headers'),
      /X-Request-ID/i,
    );
    assert.equal(
      (await fetch(harness.base + '/api/v1/health/live')).status,
      200,
    );
    assert.equal(
      (
        await fetch(harness.base + '/api/v1/health/live', {
          headers: { Origin: 'https://evil.example.test' },
        })
      ).status,
      403,
    );
    const preflight = await fetch(harness.base + '/api/v1/users/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://web.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(preflight.status, 204);
  } finally {
    await harness.close();
  }
});

test('request logs correlate failures without query, body, bearer token or incoming request ID', async () => {
  const harness = await appHarness();
  harness.health.state.initialized = true;
  try {
    const response = await fetch(
      harness.base + '/api/v1/users/login?email=PRIVATE_SENTINEL',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer PRIVATE_SENTINEL',
          'X-Request-ID': 'PRIVATE_SENTINEL',
        },
        body: '{"password":"PRIVATE_SENTINEL",',
      },
    );
    assert.equal(response.status, 400);
    assert.match(response.headers.get('x-request-id'), /^[a-f\d-]{36}$/);
    await new Promise((resolve) => setImmediate(resolve));
    const records = JSON.stringify(harness.records);
    assert.ok(!records.includes('PRIVATE_SENTINEL'));
    assert.ok(
      harness.records.some(
        (record) => record.requestId === response.headers.get('x-request-id'),
      ),
    );
  } finally {
    await harness.close();
  }
});

test('WebSocket handshake shares origin restrictions and refuses upgrades while draining', async () => {
  const server = createServer();
  let accepting = true;
  const sockets = attachMessageSocket(server, {
    isAccepting: () => accepting,
    isOriginAllowed: (origin) =>
      !origin || origin === 'https://web.example.test',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const attempt = (origin) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/api/v1/messages/socket`,
        { headers: { Origin: origin } },
      );
      ws.on('error', () => {});
      ws.on('unexpected-response', (request, response) => {
        response.resume();
        resolve(response.statusCode);
        ws.terminate();
      });
      ws.on('open', () => {
        ws.terminate();
        reject(new Error('Unexpected accepted upgrade'));
      });
    });
  try {
    assert.equal(await attempt('https://evil.example.test'), 403);
    accepting = false;
    assert.equal(await attempt('https://web.example.test'), 503);
  } finally {
    sockets.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
