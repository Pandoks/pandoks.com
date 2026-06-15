import { classifyImage, type Classification } from '@pandoks.com/react-native-image-classifier';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from 'react-native';

import { ThemedText } from '@pandoks.com/react-native-core/components/themed-text';
import { ThemedView } from '@pandoks.com/react-native-core/components/themed-view';
import { Spacing } from '@pandoks.com/react-native-core/lib/constants/theme';
import { useTheme } from '@pandoks.com/react-native-core/lib/hooks/use-theme';

export default function ImageClassifyScreen() {
  const theme = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const [results, setResults] = useState<Classification[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickAndClassify() {
    const picked = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
    if (picked.canceled) return;

    const asset = picked.assets[0];
    setUri(asset.uri);
    setResults([]);
    setError(null);
    setBusy(true);
    try {
      const found = await classifyImage({ uri: asset.uri, options: { minConfidence: 0.3 } });
      setResults(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: 'Image classify' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="small" themeColor="textSecondary">
          On-device classification — Vision (iOS) / ML Kit (Android). Runs offline.
        </ThemedText>

        <Pressable onPress={pickAndClassify}>
          <ThemedView type="backgroundElement" style={styles.btn}>
            <ThemedText type="smallBold">Pick an image</ThemedText>
          </ThemedView>
        </Pressable>

        {uri && (
          <Image source={{ uri }} style={styles.preview} contentFit="cover" transition={150} />
        )}

        {busy && <ActivityIndicator color={theme.text} />}

        {!busy && error && (
          <ThemedView type="backgroundElement" style={styles.errorBox}>
            <ThemedText type="smallBold">Classification failed</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {error}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Apple Vision needs the Neural Engine — run on a physical iPhone or the Android
              emulator (ML Kit), not the iOS Simulator.
            </ThemedText>
          </ThemedView>
        )}

        {!busy && !error && results.length > 0 && (
          <ThemedView style={styles.results}>
            <ThemedText type="subtitle">Results</ThemedText>
            {results.map((r) => (
              <ThemedText key={r.label} type="code">
                {r.label} — {(r.confidence * 100).toFixed(1)}%
              </ThemedText>
            ))}
          </ThemedView>
        )}

        {!busy && !error && uri && results.length === 0 && (
          <ThemedText type="small" themeColor="textSecondary">
            No labels above threshold.
          </ThemedText>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.three
  },
  btn: {
    padding: Spacing.three,
    borderRadius: Spacing.two,
    alignSelf: 'flex-start'
  },
  preview: {
    width: '100%',
    height: 220,
    borderRadius: Spacing.two
  },
  results: {
    gap: Spacing.one
  },
  errorBox: {
    padding: Spacing.three,
    borderRadius: Spacing.two,
    gap: Spacing.one
  }
});
