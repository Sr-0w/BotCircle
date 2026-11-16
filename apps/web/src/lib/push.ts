import { api } from '@/lib/api';

/** #64: Web Push on this browser — service worker + Push API, with the server's VAPID key. */
export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
const KEY = 'od-push-id';

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
const toBytes = (b64: string) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const label = () => { const ua = navigator.userAgent; const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur'; const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''; return [b, os].filter(Boolean).join(' · '); };

/** This browser's subscription id on the server, when push is on here. */
export function thisBrowserPushId(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }

/** Asks permission (only from a user action), subscribes, and registers this browser with the server. */
export async function enablePush(): Promise<{ ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'error'; message?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const reg = await registration(); await navigator.serviceWorker.ready;
    const { publicKey } = await api.vapidKey();
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    const { id } = await api.addPushSubscription({ kind: 'webpush', endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, label: label() });
    try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
    return { ok: true };
  } catch (e) { return { ok: false, reason: 'error', message: (e as Error).message }; }
}

export async function disablePush() {
  const id = thisBrowserPushId();
  try { const reg = await navigator.serviceWorker.getRegistration('/'); await (await reg?.pushManager.getSubscription())?.unsubscribe(); } catch { /* already gone */ }
  if (id) await api.removePushSubscription(id).catch(() => {});
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** A notification tapped: the service worker asks the open tab to go there. */
export function listenForNavigation() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'od:navigate' && typeof event.data.url === 'string') { const u = new URL(event.data.url); if (u.origin === location.origin) location.hash = u.hash; }
  });
}
