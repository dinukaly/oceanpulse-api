import { WebSocketServer, WebSocket } from 'ws';
import { authenticateAccessToken } from '../middleware/auth.js';
import { subscribeMessages, subscribeSos } from './messageEvents.js';

export function attachMessageSocket(
  server,
  {
    authenticate = authenticateAccessToken,
    heartbeatMs = 25000,
    authTimeoutMs = 5000,
    maxConnections = 500,
    maxPerUser = 5,
    isOriginAllowed = () => true,
    isAccepting = () => true,
  } = {},
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  const sessions = new Map();
  const upgrade = (request, socket, head) => {
    if (!isAccepting()) {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    if (!isOriginAllowed(request.headers.origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // No URL credentials, user-selected rooms, cookies or client-supplied recipient subscriptions.
    if (
      request.url !== '/api/v1/messages/socket' ||
      wss.clients.size >= maxConnections
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit('connection', ws),
    );
  };
  server.on('upgrade', upgrade);
  wss.on('connection', (ws) => {
    let state = 'waiting';
    let session;
    let token;
    let alive = true;
    let queued = 0;
    let sequence = Promise.resolve();
    let expiry;
    const deadline = setTimeout(
      () => ws.close(4401, 'Authentication required'),
      authTimeoutMs,
    );
    const fail = (error) =>
      ws.close(error?.statusCode === 401 ? 4401 : 1013, 'Session unavailable');
    const send = (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 65536)
        return ws.close(1013, 'Reconnect to recover history');
      ws.send(JSON.stringify(event));
    };
    // Revalidate before each payload so revoked/inactive sessions cannot receive later content.
    const enqueue = (event, canReceive = () => true) => {
      if (++queued > 50) return ws.close(1013, 'Reconnect to recover history');
      sequence = sequence
        .then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const current = await authenticate(token);
          if (canReceive(current)) send(event);
        })
        .catch(fail)
        .finally(() => {
          queued--;
        });
    };
    ws.on('error', () => {}); // Do not log frames, tokens or message contents.
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', async (data, binary) => {
      if (state !== 'waiting' || binary)
        return ws.close(4400, 'Invalid protocol');
      state = 'authenticating';
      try {
        const frame = JSON.parse(data.toString());
        if (
          frame.type !== 'auth' ||
          typeof frame.token !== 'string' ||
          frame.token.length > 3500
        ) {
          return ws.close(4401, 'Authentication required');
        }
        token = frame.token;
        session = await authenticate(token);
        if (ws.readyState !== WebSocket.OPEN) return;
        const count = [...sessions.values()].filter(
          (value) => value.userId === session.userId,
        ).length;
        if (count >= maxPerUser) return ws.close(4429, 'Too many connections');
        sessions.set(ws, { userId: session.userId, enqueue });
        state = 'ready';
        clearTimeout(deadline);
        if (Number.isFinite(session.expiresAt)) {
          expiry = setTimeout(
            () => ws.close(4401, 'Session expired'),
            Math.max(0, session.expiresAt * 1000 - Date.now()),
          );
        }
        send({ type: 'ready', userId: session.userId });
      } catch (error) {
        fail(error);
      }
    });
    const heartbeat = setInterval(() => {
      if (state !== 'ready' || ws.readyState !== WebSocket.OPEN) return;
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
      enqueue({ type: 'heartbeat' });
    }, heartbeatMs);
    ws.on('close', () => {
      clearTimeout(deadline);
      clearTimeout(expiry);
      clearInterval(heartbeat);
      sessions.delete(ws);
    });
  });
  const unsubscribe = subscribeMessages((userIds, event) => {
    for (const session of sessions.values()) {
      if (userIds.has(session.userId)) session.enqueue(event);
    }
  });
  const unsubscribeSos = subscribeSos((event, targetRole, recipientIds) => {
    for (const session of sessions.values()) {
      if (targetRole || recipientIds.has(session.userId)) {
        session.enqueue(event, (current) =>
          current.role === targetRole || recipientIds.has(current.userId),
        );
      }
    }
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeSos();
    server.off('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  server.once('close', close);
  return { close, wss };
}
