import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@pandoks.com/react-native/components/themed-text';
import { ThemedView } from '@pandoks.com/react-native/components/themed-view';
import { useThemeColor } from '@pandoks.com/react-native/lib/hooks/use-theme-color';

import { APP_NAME } from '@/lib/constants';

type AppHeaderProps = {
  subtitle?: string;
};

/**
 * App-specific header component with branding.
 * This is an example of an app-specific component that uses shared package components.
 */
export function AppHeader({ subtitle }: AppHeaderProps) {
  const accentColor = useThemeColor({}, 'tint');

  return (
    <ThemedView style={styles.container}>
      <View style={styles.titleRow}>
        <ThemedText type="title" style={styles.title}>
          {APP_NAME}
        </ThemedText>
        <View style={[styles.dot, { backgroundColor: accentColor }]} />
      </View>
      {subtitle && (
        <ThemedText type="subtitle" style={styles.subtitle}>
          {subtitle}
        </ThemedText>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 16
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  title: {
    letterSpacing: -0.5
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  subtitle: {
    marginTop: 4,
    opacity: 0.7
  }
});
