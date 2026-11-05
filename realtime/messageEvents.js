const messageListeners = new Set();
const sosListeners = new Set();

export function subscribeMessages(listener) {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

// Notifications are best effort. A disconnected client recovers from durable REST history.
// A notification failure must never turn an acknowledged database write into a failed send.
export function publishMessageEvent(userIds, event) {
  for (const listener of messageListeners) {
    try { listener(new Set(userIds), event); } catch { /* recovery uses REST */ }
  }
}

export function subscribeSos(listener) {
  sosListeners.add(listener);
  return () => sosListeners.delete(listener);
}

export function publishSosEvent(event, { targetRole = 'coastguard', userIds = [] } = {}) {
  const recipientIds = new Set(userIds);
  for (const listener of sosListeners) {
    try { listener(event, targetRole, recipientIds); } catch { /* recovery uses REST */ }
  }
}
