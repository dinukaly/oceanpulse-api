import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import express from 'express';

process.env.JWT_SECRET_KEY = 'coastguard-test-signing-key';
const [{ default: User }, auth, jwt, { seedStation }, { parseEnvironment }] = await Promise.all([
  import('../model/UserSchema.js'), import('../middleware/auth.js'),
  import('../utils/jwt.js'), import('../services/seedStation.js'),
  import('../config/validation.js'),
]);
const settings = {
  nodeEnv: 'development',
  stationSeed: { email: 'station@example.com', password: 'Station-test-pass12345', contact: '+94000000000' },
};

test('roles default to fisherman and reject unknown schema values', () => {
  assert.equal(new User().role, 'fisherman');
  assert.ok(new User({ role: 'superuser' }).validateSync().errors.role);
});

test('HTTP and socket authentication use current DB role, including legacy and revoked accounts', async () => {
  const original = User.findById;
  const user = { _id: new mongoose.Types.ObjectId(), username: 'station', isActive: true, authVersion: 0, role: 'coastguard' };
  User.findById = () => ({ select: async () => user });
  try {
    const token = jwt.generateAccessToken(user);
    assert.equal(jwt.verifyJwt(token).role, 'coastguard');
    assert.equal((await auth.authenticateAccessToken(token)).role, 'coastguard');
    const req = { headers: { authorization: `Bearer ${token}` } };
    let error;
    await auth.authenticateToken(req, {}, (value) => { error = value; });
    assert.equal(error, undefined);
    assert.equal(req.user.role, 'coastguard');
    user.role = 'fisherman';
    assert.equal((await auth.authenticateAccessToken(token)).role, 'fisherman');
    delete user.role;
    const legacyToken = jwt.generateAccessToken(user);
    assert.equal((await auth.authenticateAccessToken(legacyToken)).role, 'fisherman');
    user.authVersion = 1;
    await assert.rejects(auth.authenticateAccessToken(token), { statusCode: 401 });
    user.authVersion = 0;
    user.isActive = false;
    await assert.rejects(auth.authenticateAccessToken(token), { statusCode: 401 });
  } finally { User.findById = original; }
});

test('requireRole denies missing/fisherman/admin roles unless explicitly allowed', () => {
  for (const role of [undefined, 'fisherman', 'admin', 'coastguard']) {
    let error;
    auth.requireRole('coastguard')({ user: role ? { role } : undefined }, {}, (value) => { error = value; });
    assert.equal(error?.statusCode, role === 'coastguard' ? undefined : 403);
  }
  let error;
  auth.requireRole('coastguard', 'admin')({ user: { role: 'admin' } }, {}, (value) => { error = value; });
  assert.equal(error, undefined);
});

test('station seed is insert-only, hashes credentials, and rejects account collisions', async () => {
  let saved;
  let creates = 0;
  const logs = [];
  const UserModel = {
    findOne: async () => saved,
    create: async (value) => { creates++; saved = new User(value); await saved.validate(); return saved; },
  };
  const logger = { info: (...args) => logs.push(args) };
  assert.equal(await seedStation({ settings: {}, UserModel }), null);
  const station = await seedStation({ settings, UserModel, logger });
  assert.equal(station.role, 'coastguard');
  assert.equal(station.isActive, true);
  assert.ok(await bcrypt.compare(settings.stationSeed.password, station.password));
  assert.ok(!JSON.stringify(logs).includes(settings.stationSeed.password));
  await seedStation({ settings: { ...settings, stationSeed: { ...settings.stationSeed, password: 'Changed-pass123456' } }, UserModel });
  assert.equal(creates, 1);
  assert.ok(await bcrypt.compare(settings.stationSeed.password, saved.password));
  saved.role = 'fisherman';
  await assert.rejects(seedStation({ settings, UserModel }), /conflicts/);
  assert.equal(saved.role, 'fisherman');
  saved.role = 'coastguard'; saved.isActive = false;
  await assert.rejects(seedStation({ settings, UserModel }), /conflicts/);
  await assert.rejects(seedStation({ settings: { ...settings, nodeEnv: 'production' }, UserModel }), /disabled/);
});

test('concurrent station seed recovers unique email winner without overwriting', async () => {
  let lookups = 0;
  const winner = { role: 'coastguard', isActive: true };
  const UserModel = {
    findOne: async () => ++lookups === 1 ? null : winner,
    create: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); },
  };
  assert.equal(await seedStation({ settings, UserModel }), winner);
});

test('seeded station logs in via existing HTTP auth and role guard returns FORBIDDEN for fishermen', async () => {
  const [{ default: routes }, { errorHandler }, { default: Counter }] = await Promise.all([
    import('../routes/UserRoute.js'), import('../middleware/errorHandler.js'), import('../model/AuthRateLimitSchema.js'),
  ]);
  const original = { findOne: User.findOne, findById: User.findById, counter: Counter.findOneAndUpdate };
  const station = await seedStation({ settings, UserModel: {
    findOne: async () => null, create: async (value) => new User(value),
  } });
  User.findOne = async ({ email }) => email === station.email ? station : null;
  User.findById = () => ({ select: async () => station });
  Counter.findOneAndUpdate = async () => ({ count: 1 });
  const app = express();
  app.use(express.json());
  app.use('/users', routes);
  app.get('/responder', auth.authenticateToken, auth.requireRole('coastguard'), (req, res) => res.json(req.user));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: settings.stationSeed.email, password: settings.stationSeed.password }) });
    assert.equal(login.status, 200);
    const { data } = await login.json();
    assert.equal(data.user.role, 'coastguard');
    assert.equal(data.user.password, undefined);
    const headers = { Authorization: `Bearer ${data.token}` };
    assert.equal((await fetch(`${base}/responder`, { headers })).status, 200);
    station.role = 'fisherman';
    const denied = await fetch(`${base}/responder`, { headers });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'FORBIDDEN');
    assert.equal((await fetch(`${base}/responder`)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findOne = original.findOne;
    User.findById = original.findById;
    Counter.findOneAndUpdate = original.counter;
  }
});

test('development seeding configuration is explicit and validates credentials', () => {
  const base = { JWT_SECRET_KEY: 'test-only-key', NODE_ENV: 'development' };
  assert.equal(parseEnvironment(base).stationSeed, undefined);
  const enabled = { ...base, DEV_SEED_COASTGUARD: 'true', COASTGUARD_STATION_EMAIL: 'STATION@example.com',
    COASTGUARD_STATION_PASSWORD: settings.stationSeed.password, COASTGUARD_STATION_CONTACT: '+94000000000' };
  assert.equal(parseEnvironment(enabled).stationSeed.email, 'station@example.com');
  for (const overrides of [
    { NODE_ENV: 'production' }, { NODE_ENV: 'test' }, { DEV_SEED_COASTGUARD: 'yes' },
    { COASTGUARD_STATION_PASSWORD: 'short1' }, { COASTGUARD_STATION_PASSWORD: 'a1'.repeat(37) },
    { COASTGUARD_STATION_EMAIL: 'invalid' }, { COASTGUARD_STATION_CONTACT: '' },
  ]) assert.throws(() => parseEnvironment({ ...enabled, ...overrides }), { name: 'ConfigurationError' });
});

test('real MongoDB: concurrent station seeds persist a single usable station',
  { skip: !process.env.AUTH_TEST_MONGODB_URI }, async () => {
    const connection = await mongoose.createConnection(process.env.AUTH_TEST_MONGODB_URI, {
      dbName: `oceanpulse_station_test_${Date.now()}_${process.pid}`, serverSelectionTimeoutMS: 5000,
    }).asPromise();
    const UserModel = connection.model('StationTestUser', User.schema);
    try {
      await UserModel.init();
      await Promise.all(Array.from({ length: 5 }, () => seedStation({ settings, UserModel })));
      assert.equal(await UserModel.countDocuments(), 1);
      const station = await UserModel.findOne({ email: settings.stationSeed.email });
      assert.equal(station.role, 'coastguard');
      assert.ok(await bcrypt.compare(settings.stationSeed.password, station.password));
      await UserModel.collection.insertOne({ username: 'legacy', email: 'legacy@example.com' });
      assert.equal((await UserModel.findOne({ email: 'legacy@example.com' })).role, 'fisherman');
    } finally {
      await UserModel.init();
      try { await connection.dropDatabase(); } finally { await connection.close(); }
    }
  });

test('real startup seeds station before listening and preserves its credentials after restart',
  { skip: !process.env.AUTH_TEST_MONGODB_URI }, async () => {
    const [{ startServer }, { config }] = await Promise.all([import('../app.js'), import('../config/env.js')]);
    const dbName = `oceanpulse_station_startup_test_${Date.now()}_${process.pid}`;
    const options = { mongoUri: process.env.AUTH_TEST_MONGODB_URI, dbName, port: 0, host: '127.0.0.1',
      settings: { ...config, ...settings, logLevel: 'silent' } };
    let runtime;
    try {
      runtime = await startServer(options);
      const station = await User.findOne({ email: settings.stationSeed.email });
      const hash = station.password;
      const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/v1/users/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: settings.stationSeed.email, password: settings.stationSeed.password }),
      });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      assert.equal(data.user.role, 'coastguard');
      assert.equal((await auth.authenticateAccessToken(data.token)).role, 'coastguard');
      await runtime.close(); runtime = null;
      runtime = await startServer(options);
      assert.equal(await User.countDocuments({ email: settings.stationSeed.email }), 1);
      assert.equal((await User.findById(station._id)).password, hash);
    } finally {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) {
        await mongoose.connection.dropDatabase();
      }
      await runtime?.close();
    }
  });
