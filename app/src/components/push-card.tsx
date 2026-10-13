import { useState } from 'react';
import { Platform, Text } from 'react-native';

import { Button, Card } from '@/components/ui';
import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import { useAlerts } from '@/lib/alerts';

// Browser notifications: on/off, or why they aren't available here.
export function PushCard({ compact }: { compact?: boolean }) {
  const { push, enablePush, disablePush } = useAlerts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    fn().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  if (compact && push === 'on') return null;
  const text = {
    on: 'Notifications are on in this browser. You will get one when a wallet you follow trades.',
    off: 'Get a notification in this browser when a wallet you follow buys or sells.',
    blocked: 'Notifications are blocked for FloorFeed in this browser. Allow them in the site settings to turn alerts on.',
    unsupported: Platform.OS === 'web'
      ? 'This browser can’t show notifications. On iPhone, add FloorFeed to your Home Screen first.'
      : 'Notifications are coming to the app. Until then, alerts collect here.',
  }[push];
  return (
    <Card style={compact ? { padding: 14 } : undefined}>
      <Text style={T.body}>{text}</Text>
      {push === 'off' && <Button label={busy ? 'Turning on…' : 'Turn on notifications'} disabled={busy} onPress={() => run(enablePush)} />}
      {push === 'on' && !compact && <Button tone="secondary" label="Turn off" disabled={busy} onPress={() => run(disablePush)} />}
      {error && <Text style={[T.meta, { color: C.down }]}>{error}</Text>}
    </Card>
  );
}
