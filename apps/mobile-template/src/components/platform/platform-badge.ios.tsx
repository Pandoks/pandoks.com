import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export function PlatformBadge() {
  return (
    <ThemedView style={[styles.badge, styles.ios]}>
      <ThemedText type="defaultSemiBold" style={styles.text}>
        iOS build
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
  ios: {
    backgroundColor: '#E5F1FF'
  },
  text: {
    color: '#1C3B6F',
    fontSize: 12,
    letterSpacing: 0.3
  }
});
