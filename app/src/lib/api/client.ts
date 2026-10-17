// HTTP plumbing shared by the endpoint modules in this folder.

// Point EXPO_PUBLIC_API_URL at the server's LAN address when running on a
// phone (localhost only works for web/simulators on the same machine).
export const BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8030';
// Absolute API URL (BASE may be relative, e.g. '/api'), for code outside fetch helpers.
export const apiUrl = (path: string) => new URL(BASE + path, typeof location !== 'undefined' ? location.href : 'http://localhost').toString();

// Signed-in (Privy) users send their access token; anonymous device ids don't.
let tokenGetter: (() => Promise<string | null>) | null = null;
export const setTokenGetter = (fn: typeof tokenGetter) => { tokenGetter = fn; };

// Throws the server's `{ error }` message (what the app shows), or the status.
export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) headers['content-type'] = 'application/json';
  const token = tokenGetter ? await tokenGetter().catch(() => null) : null;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (null as T) : res.json();
}

// A JSON body request.
export const send = <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown) =>
  req<T>(path, { method, body: JSON.stringify(body) });

// Path template that URL-encodes every interpolated value: path`/wallets/${address}`.
export const path = (parts: TemplateStringsArray, ...values: (string | number)[]) =>
  parts.reduce((out, part, i) => out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');

// `?a=1&b=2` from the params that are set (undefined, null, false and '' are left out); '' when none are.
export const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== false && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};
