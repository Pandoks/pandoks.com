import { useTheme } from 'expo-router';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Screen } from '../components/screen';

const CARD_TITLES = ['Inbox', 'Today', 'Upcoming', 'Projects', 'Archive', 'Trash'];

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  // NOTE: Material window size class breakpoints (compact, medium, expanded)
  const columns = width >= 840 ? 3 : width >= 600 ? 2 : 1;

  return (
    <Screen title="Home">
      <View style={styles.grid}>
        {CARD_TITLES.map((cardTitle) => (
          <View key={cardTitle} testID="card" style={[styles.cell, { width: `${100 / columns}%` }]}>
            <View
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Text style={[styles.cardTitle, { color: colors.text }]}>{cardTitle}</Text>
            </View>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', margin: -8 },
  cell: { padding: 8 },
  card: { minHeight: 96, padding: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  cardTitle: { fontSize: 17, fontWeight: '600' }
});
