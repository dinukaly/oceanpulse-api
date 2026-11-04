import { isIP } from 'node:net';

export class ConfigurationError extends Error {
  constructor(field, requirement) {
    super(`${field} ${requirement}`);
    this.name = 'ConfigurationError';
    this.field = field;
  }
}

const invalid = (field, requirement) => {
  throw new ConfigurationError(field, requirement);
};
const number = (env, field, fallback, min, max) => {
  const raw = env[field] ?? String(fallback);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  ) {
    invalid(field, `must be an integer from ${min} to ${max}`);
  }
  return Number(raw);
};

function origins(raw) {
  if (raw?.trim() === 'none') return [];
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw.split(',').map((value) => {
        const text = value.trim();
        try {
          const url = new URL(text);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/' ||
            url.hostname.includes('*') ||
            url.origin === 'null'
          )
            throw new Error();
          return url.origin;
        } catch {
          return invalid(
            'CORS_ALLOWED_ORIGINS',
            'must contain exact http(s) origins without paths, credentials or wildcards',
          );
        }
      }),
    ),
  ];
}

function trustProxy(raw = 'false') {
  if (raw === 'false') return false;
  const values = raw.split(',').map((value) => value.trim());
  for (const value of values) {
    if (value === 'loopback') continue;
    const [address, prefix, extra] = value.split('/');
    const family = isIP(address);
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) < 1 ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    ) {
      invalid(
        'TRUST_PROXY',
        'must be false, loopback, or explicit IP/CIDR entries; blanket trust and hop counts are not supported',
      );
    }
  }
  return values;
}

export function parseEnvironment(env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv))
    invalid('NODE_ENV', 'must be development, test or production');
  const production = nodeEnv === 'production';
  const jwtSecret = env.JWT_SECRET_KEY;
  if (!jwtSecret?.trim()) invalid('JWT_SECRET_KEY', 'is required');
  if (production && Buffer.byteLength(jwtSecret, 'utf8') < 32)
    invalid('JWT_SECRET_KEY', 'must contain at least 32 bytes in production');
  const mongoUri =
    env.MONGODB_URI ||
    (production ? '' : 'mongodb://127.0.0.1:27017/oceanpulse_db');
  if (!/^mongodb(?:\+srv)?:\/\/\S+$/.test(mongoUri))
    invalid(
      'MONGODB_URI',
      'must be an explicit MongoDB connection URI in production',
    );
  const corsOrigins = origins(env.CORS_ALLOWED_ORIGINS);
  if (
    production &&
    !corsOrigins.length &&
    env.CORS_ALLOWED_ORIGINS?.trim() !== 'none'
  )
    invalid('CORS_ALLOWED_ORIGINS', 'is required in production');
  const logLevel = env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info');
  if (!['silent', 'error', 'warn', 'info'].includes(logLevel))
    invalid('LOG_LEVEL', 'must be silent, error, warn or info');
  const sendgridApiKey = env.SENDGRID_API_KEY || undefined;
  const sendgridFromEmail = env.SENDGRID_FROM_EMAIL || undefined;
  const emailProvider = env.EMAIL_PROVIDER || 'sendgrid';
  if (!['sendgrid', 'resend'].includes(emailProvider))
    invalid('EMAIL_PROVIDER', 'must be sendgrid or resend');
  const resendApiKey = env.RESEND_API_KEY?.trim() || undefined;
  const resendFromEmail = env.RESEND_FROM_EMAIL?.trim() || undefined;
  if (production && Boolean(resendApiKey) !== Boolean(resendFromEmail))
    invalid('RESEND_API_KEY/RESEND_FROM_EMAIL', 'must be configured together or both omitted');
  const devLogVerificationCodes = env.DEV_LOG_VERIFICATION_CODES ?? 'false';
  if (!['true', 'false'].includes(devLogVerificationCodes))
    invalid('DEV_LOG_VERIFICATION_CODES', 'must be true or false');
  if (devLogVerificationCodes === 'true' && nodeEnv !== 'development')
    invalid('DEV_LOG_VERIFICATION_CODES', 'is allowed only in development');
  if (production && Boolean(sendgridApiKey) !== Boolean(sendgridFromEmail))
    invalid(
      'SENDGRID_API_KEY/SENDGRID_FROM_EMAIL',
      'must be configured together or both omitted',
    );
  const host = env.HOST || '0.0.0.0';
  if (!isIP(host) && host !== 'localhost')
    invalid('HOST', 'must be a bind IP address or localhost');
  return {
    nodeEnv,
    jwtSecret,
    mongoUri,
    corsOrigins,
    corsNativeOnly: env.CORS_ALLOWED_ORIGINS?.trim() === 'none',
    logLevel,
    sendgridApiKey,
    sendgridFromEmail,
    emailProvider,
    resendApiKey,
    resendFromEmail,
    devLogVerificationCodes: devLogVerificationCodes === 'true',
    host,
    port: number(env, 'PORT', 3000, 1, 65535),
    weatherApiKey: env.WEATHER_API_KEY || undefined,
    trustProxy: trustProxy(env.TRUST_PROXY),
    mongoSelectionTimeoutMs: number(
      env,
      'MONGODB_SELECTION_TIMEOUT_MS',
      5000,
      100,
      60000,
    ),
    mongoSocketTimeoutMs: number(
      env,
      'MONGODB_SOCKET_TIMEOUT_MS',
      30000,
      100,
      300000,
    ),
    readinessTimeoutMs: number(env, 'READINESS_TIMEOUT_MS', 1500, 50, 5000),
    shutdownGraceMs: number(env, 'SHUTDOWN_GRACE_MS', 10000, 100, 60000),
    autoIndex: !production,
  };
}
