import { StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

type PlatformBadgeProps = {
  label?: string;
};

export function PlatformBadge({ label = 'Native build' }: PlatformBadgeProps) {
  return (
    <ThemedView style={styles.badge}>
      <ThemedText type="defaultSemiBold" style={styles.text}>
        {label}
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
  text: {
    fontSize: 12,
    letterSpacing: 0.3
  }
});
