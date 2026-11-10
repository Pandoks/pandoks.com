import { useEffect } from 'react';
import { AppState, Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from 'expo-router';
import * as Updates from 'expo-updates';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Checks for an update whenever the app returns to the foreground, on top of expo-updates' check on launch, and
// offers a restart once one has downloaded. Ignored, it applies on the next launch.
export function UpdateBanner() {
  const { isUpdatePending } = Updates.useUpdates();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

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
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => Updates.reloadAsync()}
      style={[styles.banner, { top: insets.top + 8, backgroundColor: colors.primary }]}
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
