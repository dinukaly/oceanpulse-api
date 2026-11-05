import mongoose from "mongoose";
import SosAlert from "../model/SosAlertSchema.js";
import User from "../model/UserSchema.js";
import BoatLocation from "../model/BoatLocationSchema.js";
import { successResponse } from '../utils/responseHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { actorId, requireMatchingIdentity } from '../utils/actor.js';
import { jsonObject, objectId, text } from '../utils/validation.js';
import { pagination, pageResult } from '../utils/pagination.js';
import { alertStatus, sosReceipt, unconfirmedReceipt } from '../utils/sosReceipt.js';
import { publishSosEvent } from '../realtime/messageEvents.js';

const statusFilter = (status) => {
  if (status === 'ACTIVE' || status === 'RESOLVED') {
    return { $or: [{ status }, { status: { $exists: false }, isHandled: status === 'RESOLVED' }] };
  }
  return { status };
};

const updateOptions = {
  new: true,
  runValidators: true,
  writeConcern: { w: 'majority', wtimeout: 5000 },
  maxTimeMS: 5000,
};

const auditNote = (actor, action, message, timestamp) => ({
  message, authorId: actor.userId, authorName: actor.username, action, timestamp,
});

export const formatAlertDto = (alert) => {
  if (!alert) return null;
  const doc = alert.toObject ? alert.toObject() : alert;
  return {
    id: doc._id ? String(doc._id) : String(doc.id),
    userId: String(doc.userId),
    username: doc.username,
    fishermanName: doc.fishermanName || doc.username,
    contact: doc.contact || '',
    boatId: doc.boatId || '',
    latitude: doc.latitude,
    longitude: doc.longitude,
    timestamp: doc.timestamp ? new Date(doc.timestamp).toISOString() : null,
    status: alertStatus(doc),
    isHandled: Boolean(doc.isHandled),
    handledBy: doc.handledBy ? String(doc.handledBy) : null,
    handledByName: doc.handledByName || null,
    acknowledgedAt: doc.acknowledgedAt ? new Date(doc.acknowledgedAt).toISOString() : null,
    resolvedAt: doc.resolvedAt ? new Date(doc.resolvedAt).toISOString() : null,
    cancelledAt: doc.cancelledAt ? new Date(doc.cancelledAt).toISOString() : null,
    notes: (doc.notes || []).map((note) => ({
      id: note._id ? String(note._id) : undefined,
      message: note.message,
      authorId: note.authorId ? String(note.authorId) : null,
      authorName: note.authorName,
      action: note.action,
      timestamp: note.timestamp ? new Date(note.timestamp).toISOString() : null,
    })),
  };
};

const saveSosMessage = async (req, res, next) => {
  try {
    const { latitude, longitude } = jsonObject(req.body);
    const userId = requireMatchingIdentity(req, req.body.userId, req.body.username);
    const username = req.user.username;

    if (
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new AppError('Valid latitude and longitude are required', 400);
    }

    // Snapshot fisherman profile fields (name, contact, boatId)
    let fishermanName = username;
    let contact = '';
    let boatId = '';
    try {
      const query = User.findById(userId).select('firstName lastName contact boatId');
      const userDoc = query && typeof query.lean === 'function' ? await query.lean() : await query;
      if (userDoc) {
        const fullName = [userDoc.firstName, userDoc.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        fishermanName = fullName || username;
        contact = userDoc.contact || '';
        boatId = userDoc.boatId || '';
      }
    } catch (_) {
      // Fallback gracefully to default identity if User model is stubbed or unavailable
    }

    const filter = { userId, isHandled: false };
    const now = new Date();
    const insertDoc = {
      userId,
      username,
      latitude,
      longitude,
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      isHandled: false,
      status: 'ACTIVE',
      fishermanName,
      contact,
      boatId,
      notes: [
        {
          message: 'Distress beacon activated from vessel',
          authorName: username,
          action: 'CREATED',
          timestamp: now,
        },
      ],
    };

    let result;
    try {
      result = await SosAlert.findOneAndUpdate(
        filter,
        { $setOnInsert: insertDoc },
        {
          ...updateOptions,
          upsert: true,
          timestamps: false,
          rawResult: true,
        }
      );
    } catch (error) {
      if (error.code !== 11000 || (error.keyPattern && !error.keyPattern.userId)) {
        throw error;
      }
      // Concurrent first inserts can race at the unique index. Return the winner.
      const existing = await SosAlert.findOne(filter)
        .read('primary')
        .readConcern('majority')
        .maxTimeMS(5000);
      if (!existing) throw unconfirmedReceipt();
      successResponse(res, sosReceipt(existing, userId, true));
      return;
    }

    if (
      result?.ok !== 1 ||
      result.lastErrorObject?.n !== 1 ||
      !result.value ||
      typeof result.lastErrorObject?.updatedExisting !== 'boolean'
    ) {
      throw unconfirmedReceipt();
    }

    const alreadyActive = result.lastErrorObject.updatedExisting;

    // Real-time broadcast to coastal guard responders on new distress beacon
    if (!alreadyActive) {
      publishSosEvent(
        {
          type: 'sos.created',
          alert: formatAlertDto(result.value),
        },
        { targetRole: 'coastguard' }
      );
    }

    successResponse(
      res,
      sosReceipt(result.value, userId, alreadyActive),
      alreadyActive ? 200 : 201
    );
  } catch (error) {
    next(error);
  }
};

const getResponderAlerts = async (req, res, next) => {
  try {
    const { limit, filter } = pagination(req.query);
    const queryFilter = { ...filter };

    if (req.query.status !== undefined) {
      const statusParam = text(req.query.status, 'status filter', 20).toUpperCase();
      if (['ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'CANCELLED'].includes(statusParam)) {
        Object.assign(queryFilter, statusFilter(statusParam));
      } else if (statusParam !== 'ALL') {
        throw new AppError('Invalid status filter', 400);
      }
    } else if (req.query.isHandled === 'false') {
      queryFilter.isHandled = false;
    } else if (req.query.isHandled === 'true') {
      queryFilter.isHandled = true;
    }

    const alerts = await SosAlert.find(queryFilter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const page = pageResult(alerts, limit);
    successResponse(res, page.items.map(formatAlertDto), 200, { pagination: page.pagination });
  } catch (error) {
    next(error);
  }
};

const getResponderAlertById = async (req, res, next) => {
  try {
    const alertId = objectId(req.params.alertId, 'alert ID');
    const alert = await SosAlert.findById(alertId).lean();
    if (!alert) {
      throw new AppError('SOS alert not found', 404);
    }

    let latestBoatLocation = null;
    try {
      if (mongoose.connection.readyState === 1) {
        const boatLoc = await BoatLocation.findOne({ userId: alert.userId }).lean();
        if (boatLoc && boatLoc.location?.coordinates) {
          latestBoatLocation = {
            longitude: boatLoc.location.coordinates[0],
            latitude: boatLoc.location.coordinates[1],
            lastUpdated: boatLoc.lastUpdated,
          };
        }
      }
    } catch (_) {}

    const alertDto = formatAlertDto(alert);
    successResponse(res, { ...alertDto, latestBoatLocation });
  } catch (error) {
    next(error);
  }
};

const updateAlertStatus = async (req, res, next) => {
  try {
    const rawId = req.params.alertId || req.params.messageId;
    const alertId = objectId(rawId, 'alert ID');
    const { status, note } = jsonObject(req.body);

    if (!['ACKNOWLEDGED', 'RESOLVED'].includes(status)) {
      throw new AppError('Status must be ACKNOWLEDGED or RESOLVED', 400);
    }

    const acknowledging = status === 'ACKNOWLEDGED';
    const action = acknowledging ? 'ACKNOWLEDGE' : 'RESOLVE';
    const noteMessage = (note === undefined ? '' : text(note, 'note', 1000, true)) ||
      (acknowledging ? 'Distress call acknowledged by Coast Guard operations' : 'Incident marked resolved');
    const now = new Date();
    const alert = await SosAlert.findOneAndUpdate(
      { _id: alertId, isHandled: false, ...statusFilter(acknowledging ? 'ACTIVE' : 'ACKNOWLEDGED') },
      {
        $set: {
          status, isHandled: !acknowledging,
          handledBy: req.user.userId, handledByName: req.user.username,
          [acknowledging ? 'acknowledgedAt' : 'resolvedAt']: now,
        },
        $push: { notes: auditNote(req.user, action, noteMessage, now) },
      },
      updateOptions,
    );
    if (!alert) {
      if (!await SosAlert.findById(alertId).lean()) throw new AppError('SOS alert not found', 404);
      throw new AppError('SOS alert is no longer in the required state', 409);
    }
    const alertDto = formatAlertDto(alert);

    // Broadcast update to Coast Guard dashboard and the affected fisherman
    publishSosEvent(
      {
        type: 'sos.updated',
        alert: alertDto,
      },
      { targetRole: 'coastguard', userIds: [alert.userId] }
    );

    successResponse(res, alertDto);
  } catch (error) {
    next(error);
  }
};

const updateSosStatus = async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'coastguard') {
      throw new AppError('SOS status updates require a responder workflow', 403);
    }
    return updateAlertStatus(req, res, next);
  } catch (error) {
    next(error);
  }
};

const addAlertNote = async (req, res, next) => {
  try {
    const alertId = objectId(req.params.alertId, 'alert ID');
    const { message, action } = jsonObject(req.body);

    if (typeof message !== 'string' || !message.trim() || message.trim().length > 1000) {
      throw new AppError('Message is required and must be under 1000 characters', 400);
    }

    const noteAction = action === 'DISPATCH' ? 'DISPATCH' : 'NOTE';
    const alert = await SosAlert.findOneAndUpdate(
      { _id: alertId, ...(noteAction === 'DISPATCH' && { isHandled: false }) },
      { $push: { notes: auditNote(req.user, noteAction, message.trim(), new Date()) } },
      updateOptions,
    ).lean();
    if (!alert) {
      if (!await SosAlert.findById(alertId).lean()) throw new AppError('SOS alert not found', 404);
      throw new AppError('Cannot dispatch a unit for a closed SOS alert', 409);
    }
    const alertDto = formatAlertDto(alert);

    publishSosEvent(
      {
        type: 'sos.updated',
        alert: alertDto,
      },
      { targetRole: 'coastguard', userIds: [alert.userId] }
    );

    successResponse(res, alertDto);
  } catch (error) {
    next(error);
  }
};

const getResponderStats = async (req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const [activeAlertsCount, acknowledgedCount, resolvedTodayCount, responseTimes] = await Promise.all([
      SosAlert.countDocuments(statusFilter('ACTIVE')),
      SosAlert.countDocuments({ status: 'ACKNOWLEDGED' }),
      SosAlert.countDocuments({ status: 'RESOLVED', resolvedAt: { $gte: startOfDay } }),
      SosAlert.aggregate([
        { $match: {
          timestamp: { $type: 'date' },
          acknowledgedAt: { $type: 'date' },
          $expr: { $gte: ['$acknowledgedAt', '$timestamp'] },
        } },
        { $group: { _id: null, milliseconds: { $avg: { $subtract: ['$acknowledgedAt', '$timestamp'] } } } },
      ]),
    ]);

    successResponse(res, {
      activeAlertsCount,
      activeCount: activeAlertsCount,
      acknowledgedCount,
      resolvedTodayCount,
      totalOpen: activeAlertsCount + acknowledgedCount,
      averageResponseTimeMinutes: responseTimes.length ? responseTimes[0].milliseconds / 60000 : null,
    });
  } catch (error) {
    next(error);
  }
};

const cancelActiveAlert = async (req, res, next) => {
  try {
    const userId = actorId(req);
    const body = jsonObject(req.body || {});
    const rawId = body.alertId;
    const alertId = rawId ? objectId(rawId, 'alert ID') : undefined;
    const message = (body.reason === undefined ? '' : text(body.reason, 'reason', 1000, true)) ||
      'Distress beacon cancelled by vessel operator';
    const ownerFilter = alertId ? { _id: alertId, userId } : { userId, isHandled: false };
    const now = new Date();
    const alert = await SosAlert.findOneAndUpdate(
      { ...ownerFilter, isHandled: false, $or: [...statusFilter('ACTIVE').$or, { status: 'ACKNOWLEDGED' }] },
      {
        $set: { status: 'CANCELLED', isHandled: true, cancelledAt: now },
        $push: { notes: auditNote(req.user, 'CANCEL', message, now) },
      },
      updateOptions,
    );
    if (!alert) {
      const existing = await SosAlert.findOne(ownerFilter).lean();
      if (!existing) throw new AppError('SOS alert not found', 404);
      if (existing.status !== 'CANCELLED') throw new AppError('SOS alert is already closed', 409);
      return successResponse(res, { message: 'SOS alert cancelled successfully', alert: formatAlertDto(existing) });
    }
    const alertDto = formatAlertDto(alert);

    // Notify Coast Guard dashboard immediately of cancellation
    publishSosEvent(
      {
        type: 'sos.cancelled',
        alert: alertDto,
      },
      { targetRole: 'coastguard', userIds: [userId] }
    );

    successResponse(res, {
      message: 'SOS alert cancelled successfully',
      alert: alertDto,
    });
  } catch (error) {
    next(error);
  }
};

const getActiveSosAlerts = async (req, res, next) => {
  try {
    const { limit, filter } = pagination(req.query);
    const alerts = await SosAlert.find({ userId: actorId(req), isHandled: false, ...filter })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const page = pageResult(alerts, limit);
    successResponse(res, page.items, 200, { pagination: page.pagination });
  } catch (error) {
    next(error);
  }
};

const getCurrentReceipt = async (req, res, next) => {
  try {
    const userId = actorId(req);
    const includeClosed = req.query.alertId !== undefined;
    const filter = includeClosed
      ? { userId, _id: objectId(req.query.alertId, 'alert ID') }
      : { userId, isHandled: false };
    const query = SosAlert.findOne(filter)
      .read('primary')
      .readConcern('majority')
      .maxTimeMS(5000);
    const alert = includeClosed ? await query.lean() : await query;
    successResponse(res, { receipt: alert ? sosReceipt(alert, userId, true, { includeClosed }) : null });
  } catch (error) {
    next(error);
  }
};

export default {
  saveSosMessage,
  updateSosStatus,
  updateAlertStatus,
  getActiveSosAlerts,
  getCurrentReceipt,
  getResponderAlerts,
  getResponderAlertById,
  addAlertNote,
  getResponderStats,
  cancelActiveAlert,
};
