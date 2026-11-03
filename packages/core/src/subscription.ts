import { parseMultipleLinks } from './parser.ts';
import { decodeBase64Utf8, randomId } from './netUtils.ts';
import type { ServerNode, SubscriptionItem } from './types.ts';

export interface SubscriptionFetchResult {
  subscription: SubscriptionItem;
  nodes: ServerNode[];
  errors: string[];
}

function parseUserInfoHeader(headerVal: string | null): {
  uploadBytes?: number;
  downloadBytes?: number;
  totalBytes?: number;
  expireTimestamp?: number;
} {
  if (!headerVal) return {};
  const result: {
    uploadBytes?: number;
    downloadBytes?: number;
    totalBytes?: number;
    expireTimestamp?: number;
  } = {};

  const parts = headerVal.split(';').map((s) => s.trim());
  for (const part of parts) {
    const [key, val] = part.split('=').map((s) => s.trim().toLowerCase());
    const num = Number(val);
    if (!Number.isFinite(num)) continue;
    if (key === 'upload') result.uploadBytes = num;
    if (key === 'download') result.downloadBytes = num;
    if (key === 'total') result.totalBytes = num;
    if (key === 'expire') result.expireTimestamp = num * 1000;
  }
  return result;
}

export async function fetchSubscription(
  url: string,
  existingId?: string,
  customName?: string
): Promise<SubscriptionFetchResult> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    throw new Error('Subscription URL must start with http:// or https://');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(trimmedUrl, {
      headers: {
        'User-Agent': 'v2rayN/6.45 (Windows NT 10.0; Win64; x64) Xray-VPN-Client/1.0',
        Accept: '*/*',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const bodyText = await response.text();
    const subId = existingId || randomId();
    const { nodes, errors } = parseMultipleLinks(bodyText, subId);

    if (nodes.length === 0) {
      throw new Error(
        errors.length > 0
          ? `No valid VLESS/VMess nodes found (${errors[0]})`
          : 'Subscription returned 0 valid vless:// or vmess:// links'
      );
    }

    const userInfoHeader =
      response.headers.get('subscription-userinfo') ||
      response.headers.get('Subscription-Userinfo');
    const quota = parseUserInfoHeader(userInfoHeader);

    const intervalRaw =
      response.headers.get('profile-update-interval') ||
      response.headers.get('Profile-Update-Interval');
    const updateIntervalHours =
      intervalRaw && Number.isFinite(Number(intervalRaw)) && Number(intervalRaw) > 0
        ? Number(intervalRaw)
        : undefined;

    const supportUrl =
      response.headers.get('profile-web-page-url') ||
      response.headers.get('support-url') ||
      undefined;

    let resolvedName = customName?.trim() || '';
    if (!resolvedName) {
      const titleHeader =
        response.headers.get('profile-title') || response.headers.get('content-disposition');
      if (titleHeader && titleHeader.startsWith('base64:')) {
        try {
          resolvedName = decodeBase64Utf8(titleHeader.slice(7)).trim();
        } catch {
          // ignore
        }
      }
      if (!resolvedName) {
        try {
          const parsedUrl = new URL(trimmedUrl);
          resolvedName = parsedUrl.hostname;
        } catch {
          resolvedName = 'Subscription';
        }
      }
    }

    const subscription: SubscriptionItem = {
      id: subId,
      name: resolvedName,
      url: trimmedUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      enabled: true,
      ...quota,
      ...(updateIntervalHours ? { updateIntervalHours } : {}),
      ...(supportUrl ? { supportUrl } : {}),
      nodeCount: nodes.length,
    };

    return {
      subscription,
      nodes,
      errors,
    };
  } finally {
    clearTimeout(timeout);
  }
}
