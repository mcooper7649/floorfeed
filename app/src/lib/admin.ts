import { useEffect, useState } from 'react';

import { api } from './api';
import { useSession } from './session';

// Whether the signed-in account can open the admin panel (/admin): the
// server decides (ADMIN_USER_IDS). Asked once per account per session.
const known = new Map<string, boolean>();

export function useIsAdmin() {
  const { signedIn, userId } = useSession();
  const [got, setGot] = useState<{ userId: string; admin: boolean } | null>(null);
  useEffect(() => {
    if (!signedIn || !userId || known.has(userId)) return;
    let alive = true;
    api.adminMe()
      .then((r) => { known.set(userId, r.admin); if (alive) setGot({ userId, admin: r.admin }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [signedIn, userId]);
  if (!signedIn || !userId) return false;
  return known.get(userId) ?? (got?.userId === userId && got.admin);
}
