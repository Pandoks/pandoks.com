import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@pandoks.com/react-native-core/components/themed-text';
import { ThemedView } from '@pandoks.com/react-native-core/components/themed-view';
import { Spacing } from '@pandoks.com/react-native-core/lib/constants/theme';

const DEMOS: { href: Href; title: string; sub: string }[] = [
  {
    href: '/native/image-classify',
    title: 'Image classify (custom module)',
    sub: 'image-classifier: on-device Vision / ML Kit — async fn + typed return'
  }
];

export default function NativeDemosScreen() {
  return (
    <ThemedView style={styles.container}>
      <ThemedText type="title">Native</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Demos backed by our own Expo native modules (Swift + Kotlin) — capabilities no library
        covers.
      </ThemedText>

      {DEMOS.map((demo) => (
        <Link key={demo.title} href={demo.href} asChild>
          <Pressable style={({ pressed }) => pressed && styles.pressed}>
            <ThemedView type="backgroundElement" style={styles.card}>
              <ThemedText type="smallBold">{demo.title}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {demo.sub}
              </ThemedText>
            </ThemedView>
          </Pressable>
        </Link>
      ))}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.four,
    paddingTop: Spacing.six,
    gap: Spacing.three
  },
  card: {
    padding: Spacing.three,
    borderRadius: Spacing.two,
    gap: Spacing.one
  },
  pressed: {
    opacity: 0.7
  }
});
