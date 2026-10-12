import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Platform } from 'react-native';

// Browser tab title for a page. The server sends the same title with the
// first HTML (server/src/seo.ts); this keeps it right as you navigate.
// Focus-based because tab screens stay mounted when you switch away.
export function useTitle(title: string | null | undefined) {
  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'web' || !title || typeof document === 'undefined') return;
    document.title = title;
  }, [title]));
}
