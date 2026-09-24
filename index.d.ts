// Types for @profullstack/notifications (./server, ./client, ./sw).

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes). What browsers get. */
  publicKey: string;
  /** P-256 private scalar, base64url (32 bytes). Keep on the server. */
  privateKey: string;
}

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushResult {
  endpoint: string;
  status: number | null;
  sent: boolean;
  /** The push service says the subscription no longer exists: delete it. */
  gone: boolean;
  /** Why it was not sent, including the push service's response text when it gave one. */
  error: string | null;
}

export interface SendOptions {
  keys: VapidKeys;
  /** RFC 8292 contact: mailto:you@example.com or an https: URL. */
  subject: string;
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// ---- server ----
export function generateVapidKeys(): VapidKeys;
export function vapidKeysFromEnv(env?: Record<string, string | undefined>): VapidKeys | null;
export function vapidPublicKeyResponse(keys: VapidKeys | null | undefined): Response;
export function vapidHeader(keys: VapidKeys, audience: string, subject: string, now?: number): string;
export function encrypt(subscription: PushSubscriptionJSON, plaintext: Uint8Array | string): Buffer;
export function parseSubscription(input: unknown): PushSubscriptionJSON | null;
export function buildPushRequest(
  keys: VapidKeys,
  subscription: PushSubscriptionJSON,
  payload: unknown,
  options: Omit<SendOptions, 'keys' | 'fetch' | 'timeoutMs'>
): { url: string; init: RequestInit };
export function sendPush(subscription: PushSubscriptionJSON, payload: unknown, options: SendOptions): Promise<PushResult>;
export function sendPushToMany(
  subscriptions: PushSubscriptionJSON[],
  payload: unknown,
  options: SendOptions & { onGone?: (endpoint: string) => unknown }
): Promise<PushResult[]>;
export function pushSubject(mailFrom: string | null | undefined, publicUrl: string): string;

// ---- client ----
export type PushUnavailableReason =
  | 'no-window'
  | 'insecure-context'
  | 'no-service-worker'
  | 'ios-needs-install'
  | 'no-push-manager'
  | 'no-notification'
  | 'denied'
  | 'no-server-key'
  | 'save-failed';

export interface PushSupport {
  supported: boolean;
  reason: PushUnavailableReason | null;
  /** A sentence to show the user, or null when supported. */
  message: string | null;
  permission: NotificationPermission | 'unsupported';
}

export const REASON_MESSAGES: Record<string, string>;
export class PushError extends Error {
  reason: PushUnavailableReason | string;
  constructor(reason: string, message?: string);
}
export function pushSupport(env?: unknown): PushSupport;
export function getVapidPublicKey(options?: { url?: string; fetch?: typeof fetch }): Promise<string>;
export function urlBase64ToUint8Array(base64: string): Uint8Array;
export interface SubscribeOptions {
  vapidPublicKey?: string;
  vapidKeyUrl?: string;
  serviceWorkerUrl?: string;
  scope?: string;
  saveUrl?: string;
  save?: (subscription: PushSubscriptionJSON) => unknown;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  env?: unknown;
}
export function subscribe(options?: SubscribeOptions): Promise<PushSubscriptionJSON>;
export function getSubscription(options?: { scope?: string; env?: unknown }): Promise<PushSubscriptionJSON | null>;
export function unsubscribe(options?: {
  scope?: string;
  removeUrl?: string;
  headers?: Record<string, string>;
  env?: unknown;
  fetch?: typeof fetch;
}): Promise<boolean>;

// ---- service worker ----
export interface NotificationDefaults {
  title?: string;
  icon?: string;
  badge?: string;
  url?: string;
}
export function notificationFromPayload(
  text: string,
  defaults?: NotificationDefaults
): { title: string; options: NotificationOptions & { data: { url: string } } };
export function installPushHandlers(scope: unknown, defaults?: NotificationDefaults): void;
