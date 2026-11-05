import { AppError } from '../middleware/errorHandler.js';

export const unconfirmedReceipt = () => new AppError('Could not confirm the saved SOS receipt. Check the current receipt or retry.', 503, 'SOS_RECEIPT_UNCONFIRMED');

export const alertStatus = (alert) => alert.status ?? (alert.isHandled ? 'RESOLVED' : 'ACTIVE');

export const sosReceipt = (alert, userId, alreadyActive, { includeClosed = false } = {}) => {
  if (!alert || String(alert.userId) !== userId || !/^[a-f\d]{24}$/i.test(String(alert._id)) ||
      (!includeClosed && alert.isHandled !== false)) {
    throw unconfirmedReceipt();
  }
  const time = alert.timestamp == null ? null : new Date(alert.timestamp);
  const validLocation = typeof alert.latitude === 'number' && Number.isFinite(alert.latitude) && Math.abs(alert.latitude) <= 90 &&
    typeof alert.longitude === 'number' && Number.isFinite(alert.longitude) && Math.abs(alert.longitude) <= 180;
  return {
    id: String(alert._id),
    receivedAt: time && Number.isFinite(time.getTime()) ? time.toISOString() : null,
    location: validLocation ? { latitude: alert.latitude, longitude: alert.longitude } : null,
    status: 'recorded',
    responderNotified: false,
    alreadyActive,
    alertStatus: alertStatus(alert),
    dispatchRecorded: alert.notes?.some((note) => note.action === 'DISPATCH') ?? false,
    acknowledgedAt: alert.acknowledgedAt ? new Date(alert.acknowledgedAt).toISOString() : null,
    handledByName: alert.handledByName || null,
    latestNote: alert.notes && alert.notes.length ? alert.notes[alert.notes.length - 1].message : null,
  };
};
