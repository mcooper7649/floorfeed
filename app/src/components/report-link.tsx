import { router } from 'expo-router';
import { Text } from 'react-native';

import { C } from '@/constants/brand';
import { T } from '@/constants/type';
import type { SupportTopic } from '@/lib/api';

// "Report this" under an error: opens the support form prefilled with the
// error text. Sheets pass `onLeave` to close themselves first. Errors the user
// caused (cancelling in the wallet) don't need a report, so none shows.
export function ReportLink({ topic = 'bug', detail, from, onLeave, label = 'Report this problem' }: {
  topic?: SupportTopic; detail?: string; from?: string; onLeave?: () => void; label?: string;
}) {
  if (detail && /cancel+ed in your wallet|rejected|denied/i.test(detail)) return null;
  const go = () => {
    onLeave?.();
    router.push({ pathname: '/support', params: { topic, ...(detail ? { detail } : {}), ...(from ? { from } : {}) } });
  };
  return (
    <Text accessibilityRole="link" onPress={go} style={[T.caption, { color: C.accent }]}>{label} ›</Text>
  );
}
