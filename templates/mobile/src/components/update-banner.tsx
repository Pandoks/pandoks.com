import { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from 'expo-router';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function UpdateBanner() {
  const { isUpdatePending } = Updates.useUpdates();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    // NOTE: expo-updates is off in development builds, where every check rejects
    if (!Updates.isEnabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      Updates.checkForUpdateAsync()
        .then(async ({ isAvailable }) => {
          if (isAvailable) await Updates.fetchUpdateAsync();
        })
        // NOTE: a failed check keeps the running update, and useUpdates reports it as checkError
        .catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  if (!isUpdatePending) return null;
  const edgeOffset =
    Platform.OS === 'ios' && Platform.isPad
      ? { bottom: insets.bottom + 16 }
      : { top: insets.top + 8 };
  return (
    <Pressable
      accessibilityRole="button"
      disabled={reloading}
      onPress={() => {
        setReloading(true);
        void Updates.reloadAsync().catch(() => setReloading(false));
      }}
      style={[
        styles.banner,
        edgeOffset,
        { backgroundColor: colors.primary, opacity: reloading ? 0.5 : 1 }
      ]}
    >
      <Text style={styles.text}>Update ready · Restart</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20
  },
  text: { color: 'white', fontSize: 15, fontWeight: '600' }
});
