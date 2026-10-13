import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { api, type PushSubscriptionBody } from './api';
import { useSession } from './session';

// Wallet alerts: an unread count for the bell, and web push opt-in. The
// server turns every trade by a followed wallet into an alert; browsers that
// subscribed also get a notification (public/sw.js shows it).
type Alerts = {
  unread: number;
  refresh: () => void;
  markAllRead: () => Promise<void>;
  // 'unsupported': no service worker / Push API (native, old browsers, iOS
  // Safari outside an installed web app). 'blocked': the user denied it.
  push: 'unsupported' | 'blocked' | 'off' | 'on';
  enablePush: () => Promise<void>;
  disablePush: () => Promise<void>;
};

const Ctx = createContext<Alerts | null>(null);

const supported = () =>
  Platform.OS === 'web' && typeof window !== 'undefined' &&
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// VAPID keys come base64url-encoded; the Push API wants bytes.
function keyBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { userId } = useSession();
  const [unread, setUnread] = useState(0);
  const [push, setPush] = useState<Alerts['push']>(() =>
    !supported() ? 'unsupported' : Notification.permission === 'denied' ? 'blocked' : 'off');

  const refresh = useCallback(() => {
    if (!userId) return;
    api.unread(userId).then((r) => setUnread(r.unread)).catch(() => {});
  }, [userId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  // This browser's push state; an existing subscription is (re)bound to the
  // current user, so signing in moves notifications to the account.
  useEffect(() => {
    if (!supported() || !userId || Notification.permission === 'denied') return;
    currentSubscription().then((sub) => {
      if (!sub) return;
      setPush('on');
      api.subscribePush(userId, sub.toJSON() as PushSubscriptionBody).catch(() => {});
    }).catch(() => {});
  }, [userId]);

  const enablePush = useCallback(async () => {
    if (!supported() || !userId) return;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { setPush(permission === 'denied' ? 'blocked' : 'off'); return; }
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const { key } = await api.pushKey();
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
    await api.subscribePush(userId, sub.toJSON() as PushSubscriptionBody);
    setPush('on');
  }, [userId]);

  const disablePush = useCallback(async () => {
    if (!supported()) return;
    const sub = await currentSubscription();
    if (sub) {
      await api.unsubscribePush(sub.endpoint).catch(() => {});
      await sub.unsubscribe();
    }
    setPush('off');
  }, []);

  const markAllRead = useCallback(async () => {
    if (!userId) return;
    setUnread(0);
    await api.markRead(userId).catch(() => {});
  }, [userId]);

  return <Ctx value={{ unread, refresh, markAllRead, push, enablePush, disablePush }}>{children}</Ctx>;
}

export function useAlerts() {
  const a = use(Ctx);
  if (!a) throw new Error('useAlerts outside AlertsProvider');
  return a;
}
