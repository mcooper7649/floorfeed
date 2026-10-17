import { Platform } from 'react-native';

// First-party, cookie-free analytics (server: src/analytics.ts). Web only.
// Page views plus a short list of product events, sent as beacons. Where a
// visit came from (referrer, utm_*) is captured once per tab session and sent
// with every hit, so a visit counts toward one source. `?notrack=1` opts this
// browser out for good (handy for our own testing).

export type EventName =
  | 'sign_in' | 'follow' | 'unfollow' | 'alerts_on' | 'alerts_off'
  | 'paper_buy' | 'paper_sell' | 'copy_tap'
  | 'buy_open' | 'buy_click' | 'buy_signed' | 'sell_open' | 'sell_approved' | 'sell_signed' | 'bridge_click' | 'bridge_open' | 'bridge_signed' | 'unwrap_signed' | 'network_send_open' | 'network_send' | 'mint_signed' | 'mint_out' | 'mint_open' | 'mint_remind' | 'launch_draft' | 'launch_art' | 'launch_signed' | 'launch_mint' | 'list_open' | 'list_signed' | 'list_cancel' | 'offer_open' | 'offer_signed' | 'offer_cancel' | 'wrap_signed' | 'deposit_open'
  | 'wallet_connect' | 'mode_real'
  | 'welcome_shown' | 'welcome_cta' | 'welcome_dismiss' | 'suggested_follow' | 'guide_open' | 'guide_part' | 'take_post' | 'support_sent' | 'history_export';

const URL_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8030';
const web = Platform.OS === 'web' && typeof window !== 'undefined';

let signedIn = false;
export const setAnalyticsSignedIn = (v: boolean) => { signedIn = v; };

function storage(kind: 'local' | 'session') {
  try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; }
}

function optedOut() {
  if (!web) return true;
  const local = storage('local');
  if (new URLSearchParams(window.location.search).get('notrack') === '1') local?.setItem('floorfeed.notrack', '1');
  return local?.getItem('floorfeed.notrack') === '1';
}

type Origin = { r?: string; s?: string; m?: string; c?: string };
function origin(): Origin {
  const ss = storage('session');
  const saved = ss?.getItem('floorfeed.origin');
  if (saved) return JSON.parse(saved) as Origin;
  const q = new URLSearchParams(window.location.search);
  const o: Origin = {
    r: document.referrer || undefined,
    s: q.get('utm_source') ?? q.get('ref') ?? undefined,
    m: q.get('utm_medium') ?? undefined,
    c: q.get('utm_campaign') ?? undefined,
  };
  ss?.setItem('floorfeed.origin', JSON.stringify(o));
  return o;
}

function send(n: 'pageview' | EventName, path: string, props?: Record<string, string | number | boolean>) {
  if (optedOut()) return;
  const body = JSON.stringify({ n, p: path, a: signedIn, ...origin(), props });
  try {
    // text/plain keeps it a "simple" request: no CORS preflight.
    const blob = new Blob([body], { type: 'text/plain' });
    if (!navigator.sendBeacon?.(`${URL_BASE}/a`, blob)) {
      void fetch(`${URL_BASE}/a`, { method: 'POST', body, headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(() => {});
    }
  } catch { /* never break the app for analytics */ }
}

let lastPath: string | null = null;
export function pageview(path: string) {
  if (!web || path === lastPath) return;
  lastPath = path;
  send('pageview', path);
}

export function track(name: EventName, props?: Record<string, string | number | boolean>) {
  if (!web) return;
  send(name, window.location.pathname, props);
}
