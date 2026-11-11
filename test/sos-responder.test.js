import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET_KEY = 'test-only-signing-key';

const [{ default: User }, { default: Sos }, { default: BoatLocation }, { default: routes }, { errorHandler }] = await Promise.all([
  import('../model/UserSchema.js'),
  import('../model/SosAlertSchema.js'),
  import('../model/BoatLocationSchema.js'),
  import('../routes/SosAlertRoute.js'),
  import('../middleware/errorHandler.js'),
]);

const fishermanId = '507f1f77bcf86cd799439011';
const coastguardId = '507f1f77bcf86cd799439099';
const otherId = '507f1f77bcf86cd799439012';

const originals = {
  userFindById: User.findById,
  sosFind: Sos.find,
  sosFindById: Sos.findById,
  sosFindOne: Sos.findOne,
  sosUpdate: Sos.findOneAndUpdate,
  sosAggregate: Sos.aggregate,
  sosCount: Sos.countDocuments,
  boatFindOne: BoatLocation.findOne,
};

const alertsDb = new Map();

// Mock User lookup for auth middleware and snapshotting
User.findById = (id) => {
  const userIdStr = String(id);
  const isCoastguard = userIdStr === coastguardId;
  const username = isCoastguard ? 'station.commander' : userIdStr === fishermanId ? 'fisherman.saman' : 'bob';
  const role = isCoastguard ? 'coastguard' : 'fisherman';
  const userObj = {
    _id: new mongoose.Types.ObjectId(userIdStr),
    username,
    role,
    isActive: true,
    authVersion: 0,
    firstName: isCoastguard ? 'Station' : 'Saman',
    lastName: isCoastguard ? 'Commander' : 'Kumara',
    contact: isCoastguard ? '+94112345678' : '+94771234567',
    boatId: isCoastguard ? '' : 'WP-NE-4521',
  };

  return {
    select: () => ({
      lean: async () => userObj,
      then: (resolve, reject) => Promise.resolve(userObj).then(resolve, reject),
    }),
    lean: async () => userObj,
    then: (resolve, reject) => Promise.resolve(userObj).then(resolve, reject),
  };
};

BoatLocation.findOne = () => ({
  lean: async () => null,
  then: (resolve) => resolve(null),
});

function createMockAlertDoc(data) {
  const doc = {
    _id: data._id || new mongoose.Types.ObjectId(),
    userId: String(data.userId),
    username: data.username,
    fishermanName: data.fishermanName || data.username,
    contact: data.contact || '',
    boatId: data.boatId || '',
    latitude: data.latitude,
    longitude: data.longitude,
    timestamp: data.timestamp || new Date(),
    status: data.status || 'ACTIVE',
    isHandled: ['RESOLVED', 'CANCELLED'].includes(data.status),
    handledBy: data.handledBy || null,
    handledByName: data.handledByName || null,
    acknowledgedAt: data.acknowledgedAt || null,
    resolvedAt: data.resolvedAt || null,
    cancelledAt: data.cancelledAt || null,
    notes: data.notes ? [...data.notes] : [],
  };

  doc.toObject = function () {
    return {
      _id: this._id,
      userId: this.userId,
      username: this.username,
      fishermanName: this.fishermanName,
      contact: this.contact,
      boatId: this.boatId,
      latitude: this.latitude,
      longitude: this.longitude,
      timestamp: this.timestamp,
      status: this.status,
      isHandled: this.isHandled,
      handledBy: this.handledBy,
      handledByName: this.handledByName,
      acknowledgedAt: this.acknowledgedAt,
      resolvedAt: this.resolvedAt,
      cancelledAt: this.cancelledAt,
      notes: this.notes,
    };
  };

  return doc;
}

Sos.findById = (id) => {
  const doc = alertsDb.get(String(id)) || null;
  return {
    lean: async () => (doc ? doc.toObject() : null),
    then: (resolve) => resolve(doc),
  };
};

const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === '$or') return value.some((branch) => matches(doc, branch));
  if (key === '_id') return String(doc._id) === String(value);
  if (value?.$exists === false) return doc[key] === undefined;
  if (value?.$gte) return doc[key] >= value.$gte;
  return doc[key] === value;
});

Sos.findOneAndUpdate = (filter, { $set, $push }) => {
  const doc = [...alertsDb.values()].find((entry) => matches(entry, filter));
  if (doc) {
    Object.assign(doc, $set);
    doc.notes.push($push.notes);
  }
  return { lean: async () => doc?.toObject() ?? null, then: (resolve) => resolve(doc ?? null) };
};

Sos.findOne = (filter) => {
  const found = [...alertsDb.values()].find((doc) => matches(doc, filter));
  const query = {
    read: () => query,
    readConcern: () => query,
    maxTimeMS: () => query,
    lean: async () => (found ? found.toObject() : null),
    then: (resolve) => resolve(found),
  };
  return query;
};

Sos.find = (filter) => {
  const list = [...alertsDb.values()].filter((doc) => matches(doc, filter));

  const query = {
    sort: () => query,
    limit: (n) => {
      const sliced = list.slice(0, n).map((d) => d.toObject());
      return {
        lean: async () => sliced,
        then: (resolve) => resolve(sliced),
      };
    },
    lean: async () => list.map((d) => d.toObject()),
    then: (resolve) => resolve(list),
  };
  return query;
};

Sos.countDocuments = async (filter) => [...alertsDb.values()].filter((doc) => matches(doc, filter)).length;
Sos.aggregate = async () => [];

const app = express();
app.use(express.json());
app.use('/sos', routes);
app.use(errorHandler);
const server = app.listen(0);

const request = async (path, { body, actor = coastguardId, method = body ? 'POST' : 'GET' } = {}) => {
  const token = actor
    ? jwt.sign(
        { userId: actor, purpose: 'access', authVersion: 0 },
        process.env.JWT_SECRET_KEY
      )
    : null;

  const response = await fetch(`http://127.0.0.1:${server.address().port}/sos${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  };
};

beforeEach(() => {
  alertsDb.clear();
});

after(async () => {
  User.findById = originals.userFindById;
  Sos.find = originals.sosFind;
  Sos.findById = originals.sosFindById;
  Sos.findOne = originals.sosFindOne;
  Sos.findOneAndUpdate = originals.sosUpdate;
  Sos.aggregate = originals.sosAggregate;
  Sos.countDocuments = originals.sosCount;
  BoatLocation.findOne = originals.boatFindOne;
  await new Promise((resolve) => server.close(resolve));
});

test('responder alerts endpoint requires coastguard role', async () => {
  // 1. Unauthenticated -> 401
  const unauth = await request('/responder/alerts', { actor: null });
  assert.equal(unauth.status, 401);

  // 2. Fisherman role -> 403 Forbidden
  const fishermanForbidden = await request('/responder/alerts', { actor: fishermanId });
  assert.equal(fishermanForbidden.status, 403);

  // 3. Coast Guard role -> 200 OK
  const coastguardOk = await request('/responder/alerts', { actor: coastguardId });
  assert.equal(coastguardOk.status, 200);
  assert.equal(coastguardOk.body.success, true);
  assert.ok(Array.isArray(coastguardOk.body.data));
});

test('responder can list and filter alerts with snapshotted vessel metadata', async () => {
  const alert1 = createMockAlertDoc({
    _id: new mongoose.Types.ObjectId(),
    userId: fishermanId,
    username: 'fisherman.saman',
    fishermanName: 'Saman Kumara',
    contact: '+94771234567',
    boatId: 'WP-NE-4521',
    latitude: 6.9271,
    longitude: 79.8612,
    status: 'ACTIVE',
  });
  const alert2 = createMockAlertDoc({
    _id: new mongoose.Types.ObjectId(),
    userId: otherId,
    username: 'bob',
    fishermanName: 'Bob Silva',
    contact: '+94719876543',
    boatId: 'SO-GL-8910',
    latitude: 5.9496,
    longitude: 80.5353,
    status: 'RESOLVED',
  });
  alertsDb.set(String(alert1._id), alert1);
  alertsDb.set(String(alert2._id), alert2);

  // Fetch all
  const allRes = await request('/responder/alerts?status=all', { actor: coastguardId });
  assert.equal(allRes.status, 200);
  assert.equal(allRes.body.data.length, 2);

  const foundAlert1 = allRes.body.data.find((a) => a.id === String(alert1._id));
  assert.ok(foundAlert1);
  assert.equal(foundAlert1.fishermanName, 'Saman Kumara');
  assert.equal(foundAlert1.contact, '+94771234567');
  assert.equal(foundAlert1.boatId, 'WP-NE-4521');
  assert.equal(foundAlert1.status, 'ACTIVE');

  // Filter only ACTIVE
  const activeRes = await request('/responder/alerts?status=active', { actor: coastguardId });
  assert.equal(activeRes.status, 200);
  assert.equal(activeRes.body.data.length, 1);
  assert.equal(activeRes.body.data[0].status, 'ACTIVE');
});

test('responder can view single alert details and notes', async () => {
  const alertId = new mongoose.Types.ObjectId();
  const alert = createMockAlertDoc({
    _id: alertId,
    userId: fishermanId,
    username: 'fisherman.saman',
    fishermanName: 'Saman Kumara',
    contact: '+94771234567',
    boatId: 'WP-NE-4521',
    latitude: 6.9,
    longitude: 79.8,
    status: 'ACTIVE',
    notes: [
      {
        message: 'Initial distress alert',
        authorName: 'fisherman.saman',
        action: 'CREATED',
        timestamp: new Date(),
      },
    ],
  });
  alertsDb.set(String(alertId), alert);

  // Fisherman blocked
  const forbidden = await request(`/responder/alerts/${alertId}`, { actor: fishermanId });
  assert.equal(forbidden.status, 403);

  // Coast Guard allowed
  const res = await request(`/responder/alerts/${alertId}`, { actor: coastguardId });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, String(alertId));
  assert.equal(res.body.data.notes.length, 1);
  assert.equal(res.body.data.notes[0].action, 'CREATED');

  // Nonexistent alert -> 404
  const notFound = await request(`/responder/alerts/${new mongoose.Types.ObjectId()}`, { actor: coastguardId });
  assert.equal(notFound.status, 404);
});

test('status transitions: ACTIVE -> ACKNOWLEDGED -> RESOLVED with audit notes and derived isHandled', async () => {
  const alertId = new mongoose.Types.ObjectId();
  const alert = createMockAlertDoc({
    _id: alertId,
    userId: fishermanId,
    username: 'fisherman.saman',
    latitude: 6.9,
    longitude: 79.8,
    status: 'ACTIVE',
  });
  alertsDb.set(String(alertId), alert);

  // Step 1: Coast Guard Acknowledges alert
  const ackRes = await request(`/responder/alerts/${alertId}/status`, {
    actor: coastguardId,
    method: 'PATCH',
    body: { status: 'ACKNOWLEDGED', note: 'Patrol boat P-14 deployed from Colombo Harbor' },
  });
  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.body.data.status, 'ACKNOWLEDGED');
  assert.equal(ackRes.body.data.isHandled, false);
  assert.ok(ackRes.body.data.acknowledgedAt);
  assert.equal(ackRes.body.data.handledByName, 'station.commander');
  assert.equal(ackRes.body.data.notes.length, 1);
  assert.equal(ackRes.body.data.notes[0].action, 'ACKNOWLEDGE');
  assert.equal(ackRes.body.data.notes[0].message, 'Patrol boat P-14 deployed from Colombo Harbor');

  // Step 2: Add operational note during operation
  const noteRes = await request(`/responder/alerts/${alertId}/notes`, {
    actor: coastguardId,
    method: 'POST',
    body: { message: 'Vessel sighted 4 nautical miles offshore. Engaging towline.', action: 'DISPATCH' },
  });
  assert.equal(noteRes.status, 200);
  assert.equal(noteRes.body.data.notes.length, 2);
  assert.equal(noteRes.body.data.notes[1].action, 'DISPATCH');

  // Step 3: Coast Guard Resolves alert
  const resolveRes = await request(`/responder/alerts/${alertId}/status`, {
    actor: coastguardId,
    method: 'PATCH',
    body: { status: 'RESOLVED', note: 'Vessel safely escorted to harbor. Crew safe.' },
  });
  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.body.data.status, 'RESOLVED');
  assert.equal(resolveRes.body.data.isHandled, true);
  assert.ok(resolveRes.body.data.resolvedAt);

  // A terminal status cannot transition again.
  const conflictRes = await request(`/responder/alerts/${alertId}/status`, {
    actor: coastguardId,
    method: 'PATCH',
    body: { status: 'ACKNOWLEDGED' },
  });
  assert.equal(conflictRes.status, 409);
});

test('responder stats returns counts of active, acknowledged, and resolved alerts', async () => {
  alertsDb.set('1', createMockAlertDoc({ _id: '1', status: 'ACTIVE' }));
  alertsDb.set('2', createMockAlertDoc({ _id: '2', status: 'ACTIVE' }));
  alertsDb.set('3', createMockAlertDoc({ _id: '3', status: 'ACKNOWLEDGED' }));
  alertsDb.set('4', createMockAlertDoc({ _id: '4', status: 'RESOLVED', resolvedAt: new Date() }));

  const res = await request('/responder/stats', { actor: coastguardId });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.activeCount, 2);
  assert.equal(res.body.data.activeAlertsCount, 2);
  assert.equal(res.body.data.acknowledgedCount, 1);
  assert.equal(res.body.data.totalOpen, 3);
});

test('fisherman can cancel own active SOS distress alert (false alarm)', async () => {
  const alertId = new mongoose.Types.ObjectId();
  const alert = createMockAlertDoc({
    _id: alertId,
    userId: fishermanId,
    username: 'fisherman.saman',
    latitude: 6.9,
    longitude: 79.8,
    status: 'ACTIVE',
  });
  alertsDb.set(String(alertId), alert);

  // Cancel active SOS
  const cancelRes = await request('/cancel', {
    actor: fishermanId,
    method: 'POST',
    body: { alertId: String(alertId), reason: 'Accidental press, false alarm, engine running fine' },
  });

  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.data.alert.status, 'CANCELLED');
  assert.equal(cancelRes.body.data.alert.isHandled, true);
  assert.ok(cancelRes.body.data.alert.cancelledAt);
  assert.equal(cancelRes.body.data.alert.notes[0].action, 'CANCEL');
  assert.equal(cancelRes.body.data.alert.notes[0].message, 'Accidental press, false alarm, engine running fine');

  // Retrying the same cancellation does not add another audit entry.
  const secondCancel = await request('/cancel', {
    actor: fishermanId,
    method: 'POST',
    body: { alertId: String(alertId) },
  });
  assert.equal(secondCancel.status, 200);
  assert.equal(secondCancel.body.data.alert.notes.length, 1);
});
