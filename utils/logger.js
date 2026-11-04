const events = new Set([
  'http.completed',
  'http.aborted',
  'request.failed',
  'server.started',
  'server.start_failed',
  'server.stopping',
  'server.stopped',
  'server.shutdown_failed',
  'server.shutdown_timeout',
]);
const reasons = new Set(['SIGTERM', 'SIGINT', 'manual', 'startup']);
const kinds = new Set([
  'configuration',
  'validation',
  'conflict',
  'unavailable',
  'unexpected',
]);
const settings = new Set([
  'NODE_ENV',
  'JWT_SECRET_KEY',
  'MONGODB_URI',
  'CORS_ALLOWED_ORIGINS',
  'LOG_LEVEL',
  'SENDGRID_API_KEY/SENDGRID_FROM_EMAIL',
  'EMAIL_PROVIDER',
  'RESEND_API_KEY/RESEND_FROM_EMAIL',
  'DEV_LOG_VERIFICATION_CODES',
  'HOST',
  'PORT',
  'TRUST_PROXY',
  'MONGODB_SELECTION_TIMEOUT_MS',
  'MONGODB_SOCKET_TIMEOUT_MS',
  'READINESS_TIMEOUT_MS',
  'SHUTDOWN_GRACE_MS',
]);
const levels = { silent: 99, error: 3, warn: 2, info: 1 };
const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);

export function createLogger({
  level = 'info',
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const emit = (severity, event, fields = {}) => {
    if (!events.has(event) || levels[severity] < (levels[level] ?? levels.info))
      return;
    const entry = { time: new Date().toISOString(), level: severity, event };
    if (uuid(fields.requestId)) entry.requestId = fields.requestId;
    if (
      ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
        fields.method,
      )
    )
      entry.method = fields.method;
    // The route must be a constant from the route table, never a request URL or parameter.
    if (
      typeof fields.route === 'string' &&
      /^(?:unmatched|\/api\/v1\/[A-Za-z0-9_:/.-]+)$/.test(fields.route)
    )
      entry.route = fields.route;
    for (const key of ['statusCode', 'durationMs', 'port']) {
      if (Number.isFinite(fields[key]) && fields[key] >= 0)
        entry[key] = Math.round(fields[key]);
    }
    if (reasons.has(fields.reason)) entry.reason = fields.reason;
    if (kinds.has(fields.errorKind)) entry.errorKind = fields.errorKind;
    if (settings.has(fields.setting)) entry.setting = fields.setting;
    if ([13, 18, 50, 11000].includes(fields.errorCode))
      entry.errorCode = fields.errorCode;
    try {
      write(JSON.stringify(entry));
    } catch {
      /* Logging must not fail a committed request. */
    }
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
