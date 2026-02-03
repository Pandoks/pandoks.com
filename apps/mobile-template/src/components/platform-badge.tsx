import { Platform, StyleSheet } from 'react-native';
import { ThemedText } from '@pandoks.com/react-native/components/themed-text';
import { ThemedView } from '@pandoks.com/react-native/components/themed-view';

const platformConfig = Platform.select({
  ios: { label: 'iOS build', backgroundColor: '#E5F1FF', textColor: '#1C3B6F' },
  android: { label: 'Android build', backgroundColor: '#E9F7F1', textColor: '#145A3C' },
  default: { label: 'Native build', backgroundColor: '#F0F0F0', textColor: '#333333' }
});

export function PlatformBadge() {
  return (
    <ThemedView style={[styles.badge, { backgroundColor: platformConfig.backgroundColor }]}>
      <ThemedText type="defaultSemiBold" style={[styles.text, { color: platformConfig.textColor }]}>
        {platformConfig.label}
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
