import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export function PlatformBadge() {
  return (
    <ThemedView style={[styles.badge, styles.android]}>
      <ThemedText type="defaultSemiBold" style={styles.text}>
        Android build
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6
  },
  android: {
    backgroundColor: '#E9F7F1'
  },
  text: {
    color: '#145A3C',
    fontSize: 12,
    letterSpacing: 0.3
  }
});
