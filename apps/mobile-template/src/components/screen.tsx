import { type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  // NOTE: native tabs only auto-inset the first-shown iOS tab and Android's bottom; inset the rest
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: Platform.OS === 'android' ? insets.top : 0,
          paddingLeft: insets.left,
          paddingRight: insets.right
        }
      ]}
    >
      <View style={styles.column}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {children}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { alignItems: 'center' },
  column: { width: '100%', maxWidth: 1200, padding: 16, gap: 16 },
  title: { fontSize: 34, fontWeight: '700' }
});
