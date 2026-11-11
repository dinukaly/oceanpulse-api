import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { config } from './config/env.js';
import { AppError, errorHandler } from './middleware/errorHandler.js';
import AuthRateLimit from './model/AuthRateLimitSchema.js';
import SosAlert from './model/SosAlertSchema.js';
import Message from './model/MessageSchema.js';
import User from './model/UserSchema.js';
import { attachMessageSocket } from './realtime/messageSocket.js';
import { createLogger } from './utils/logger.js';
import { requestLog } from './middleware/requestLog.js';
import { createHealth } from './services/health.js';
import { seedStation } from './services/seedStation.js';

// Routes
import userRoute from './routes/UserRoute.js';
import boatLocationRoute from './routes/BoatLocationRoute.js';
import messageRoute from './routes/MessageRoute.js';
import sosAlertRoute from './routes/SosAlertRoute.js';
import weatherLogRoute from './routes/WeatherLogRoute.js';
import riskPredictionRoute from './routes/RiskPredictionRoute.js';
import communityAlertRoute from './routes/CommunityAlertRoute.js';

export function originAllowed(settings, origin) {
  return (
    !origin ||
    (!settings.corsOrigins.length &&
      settings.nodeEnv !== 'production' &&
      !settings.corsNativeOnly) ||
    settings.corsOrigins.includes(origin)
  );
}

function databaseHealth(settings) {
  return createHealth({
    connected: () => mongoose.connection.readyState === 1,
    ping: () =>
      mongoose.connection.db.command({
        ping: 1,
        maxTimeMS: settings.readinessTimeoutMs,
      }),
    timeoutMs: settings.readinessTimeoutMs,
  });
}

export function createApp({
  settings = config,
  logger = createLogger({ level: settings.logLevel }),
  health = databaseHealth(settings),
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', settings.trustProxy);
  app.use(requestLog(logger));
  app.use(
    cors({
      origin: (origin, callback) =>
        originAllowed(settings, origin)
          ? callback(null, origin || false)
          : callback(
              new AppError(
                'Browser origin is not allowed',
                403,
                'ORIGIN_NOT_ALLOWED',
              ),
            ),
      exposedHeaders: ['X-Request-ID'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
    }),
  );

  app.get('/api/v1/health/live', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { status: 'alive' } });
  });
  app.get('/api/v1/health/ready', async (req, res, next) => {
    try {
      const ready = await health.ready();
      res.set('Cache-Control', 'no-store');
      if (!ready)
        return next(
          new AppError('Service is not ready to accept requests', 503),
        );
      res.json({ success: true, data: { status: 'ready' } });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/v1/test', (req, res) => {
    res.send({ message: 'Backend is reachable!' });
  });
  app.use((req, res, next) =>
    health.accepting()
      ? next()
      : next(new AppError('Service is not ready to accept requests', 503)),
  );
  app.use(express.json());

  // Routes
  app.use('/api/v1/users', userRoute);
  app.use('/api/v1/boatLocations', boatLocationRoute);
  app.use('/api/v1/messages', messageRoute);
  app.use('/api/v1/sosAlerts', sosAlertRoute);
  app.use('/api/v1/weatherLogs', weatherLogRoute);
  app.use('/api/v1/riskPredictions', riskPredictionRoute);
  app.use('/api/v1/communityAlerts', communityAlertRoute);

  // Error handling middleware
  app.use((req, res, next) => next(new AppError('Route not found', 404)));
  app.use(errorHandler);

  return app;
}

// Production and integration tests use the same routes, middleware and index gates.
export async function startServer({
  mongoUri = config.mongoUri,
  dbName,
  port = config.port,
  host = config.host,
  settings = config,
  logger = createLogger({ level: settings.logLevel }),
} = {}) {
  let server;
  let sockets;
  const health = databaseHealth(settings);
  try {
    await mongoose.connect(mongoUri, {
      ...(dbName && { dbName }),
      serverSelectionTimeoutMS: settings.mongoSelectionTimeoutMs,
      socketTimeoutMS: settings.mongoSocketTimeoutMs,
      autoIndex: settings.autoIndex,
    });
    await Promise.all([
      AuthRateLimit.init(),
      User.init(),
      SosAlert.init(),
      Message.init(),
    ]);
    // Keep the durable-write index gates, including when autoIndex is disabled.
    await Promise.all([
      AuthRateLimit.createIndexes(),
      User.createIndexes(),
      SosAlert.createIndexes(),
      Message.createIndexes(),
    ]);

    await seedStation({ settings, logger });
    health.state.initialized = true;
    server = createServer(createApp({ settings, logger, health }));
    sockets = attachMessageSocket(server, {
      isOriginAllowed: (origin) => originAllowed(settings, origin),
      isAccepting: health.accepting,
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    logger.info('server.started', { port: server.address().port });

    let closing;
    const close = (reason = 'manual') => {
      closing ||= (async () => {
        health.state.draining = true;
        logger.info('server.stopping', { reason });
        sockets.close();
        let forced = false;
        const force = setTimeout(() => {
          forced = true;
          logger.error('server.shutdown_timeout', { reason });
          server.closeAllConnections();
          void mongoose.connection.close(true).catch(() => {});
        }, settings.shutdownGraceMs);
        force.unref();
        try {
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        } finally {
          try {
            await mongoose.disconnect();
          } finally {
            clearTimeout(force);
          }
        }
        logger.info('server.stopped', { reason });
        return { forced };
      })();
      return closing;
    };
    return { server, sockets, close, health };
  } catch (error) {
    sockets?.close();
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    throw error;
  }
}
