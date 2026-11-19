import { useTheme } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Screen } from '@/components/screen';

export default function HomeScreen() {
  const { width: windowWidth } = useWindowDimensions();
  // NOTE: an iPad sidebar narrows the pane beside it, not the window
  const [paneWidth, setPaneWidth] = useState(windowWidth);
  const { colors } = useTheme();
  // NOTE: Material window size class breakpoints (compact, medium, expanded)
  const columns = paneWidth >= 840 ? 3 : paneWidth >= 600 ? 2 : 1;

  return (
    <View
      testID="pane"
      style={styles.pane}
      onLayout={(layoutEvent) => setPaneWidth(layoutEvent.nativeEvent.layout.width)}
    >
      <Screen title="Home">
        <View style={styles.grid}>
          {['Inbox', 'Today', 'Upcoming', 'Projects', 'Archive', 'Trash'].map((cardTitle) => (
            <View
              key={cardTitle}
              testID="card"
              style={[styles.cell, { width: `${100 / columns}%` }]}
            >
              <View
                style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Text style={[styles.cardTitle, { color: colors.text }]}>{cardTitle}</Text>
              </View>
            </View>
          ))}
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', margin: -8 },
  cell: { padding: 8 },
  card: { minHeight: 96, padding: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  cardTitle: { fontSize: 17, fontWeight: '600' }
});
