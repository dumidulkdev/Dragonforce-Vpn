import type { PersistedData, ServerNode, SubscriptionItem } from './types.ts';
import { toShareLink } from './serverEdit.ts';

/** Preserve identity/telemetry across refreshes without keeping stale connection settings. */
export function replaceSubscriptionNodes(data: PersistedData, subId: string, subscription: SubscriptionItem | null, nodes: ServerNode[] = []): void {
  const existing = data.subscriptions.find((sub) => sub.id === subId);
  if (!existing) throw new Error('Subscription not found (it may have been deleted while refreshing)');
  const previous = data.servers.filter((node) => node.subscriptionId === subId);
  const remaining = new Set(previous);
  const matches = new Map<ServerNode, ServerNode>();
  const connectionKey = (node: ServerNode) => toShareLink({ ...node, name: '' });
  // Reserve unchanged profiles first. Multiple transports can share the same
  // endpoint and credentials; each old identity may be assigned only once.
  for (const node of nodes) {
    const key = connectionKey(node);
    const match = [...remaining].find((old) => connectionKey(old) === key);
    if (match) {
      matches.set(node, match);
      remaining.delete(match);
    }
  }
  for (const node of nodes) {
    const match = matches.get(node) || [...remaining].find((old) =>
      old.protocol === node.protocol && old.address === node.address && old.port === node.port && old.uuid === node.uuid
    );
    if (!match) continue;
    remaining.delete(match);
    node.id = match.id;
    node.geo = match.geo ?? null;
    node.ping = match.ping ?? null;
    if (match.pingStatus !== 'measuring') {
      node.pingStatus = match.pingStatus;
      node.pingError = match.pingError;
      node.pingCheckedAt = match.pingCheckedAt;
    }
  }
  if (subscription) {
    subscription.createdAt = existing.createdAt || existing.updatedAt;
    subscription.totalBytes ??= existing.totalBytes;
    subscription.expireTimestamp ??= existing.expireTimestamp;
    data.subscriptions[data.subscriptions.indexOf(existing)] = subscription;
  } else {
    data.subscriptions = data.subscriptions.filter((sub) => sub.id !== subId);
  }
  data.servers = [...data.servers.filter((node) => node.subscriptionId !== subId), ...nodes];
  if (!data.servers.some((node) => node.id === data.activeServerId)) {
    data.activeServerId = data.servers[0]?.id || null;
  }
}
