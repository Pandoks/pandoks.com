import { useReservedRegions } from '@pandoks.com/react-native-reserved-regions';
import { useTheme } from 'expo-router';
import { type ComponentRef, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '../components/screen';

const cardTitles = ['Inbox', 'Today', 'Upcoming', 'Projects', 'Archive', 'Trash'];

// NOTE: Material window size class breakpoints (compact, medium, expanded)
function columnsFor(width: number) {
  return width >= 840 ? 3 : width >= 600 ? 2 : 1;
}

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  const gridRef = useRef<ComponentRef<typeof View>>(null);
  const [grid, setGrid] = useState({ x: 0, width: 0 });
  const fold = useReservedRegions({ includeInactive: true }).find(
    (region) => region.kind === 'division' && region.frame.height > region.frame.width
  );

  // NOTE: the screen pads the grid by the insets, so render again to measure when they change
  useSafeAreaInsets();

  // NOTE: measuring synchronously before paint keeps cards off the fold from the first frame
  useLayoutEffect(() => {
    gridRef.current?.measureInWindow((x, _y, gridWidth) =>
      setGrid((previous) =>
        previous.x === x && previous.width === gridWidth ? previous : { x, width: gridWidth }
      )
    );
  });

  const foldStart = fold ? fold.frame.x - grid.x : 0;
  const foldEnd = fold ? foldStart + fold.frame.width : 0;
  const split = foldStart > 0 && foldEnd < grid.width;
  const panes = split
    ? [{ width: foldStart }, { flex: 1, marginLeft: foldEnd - foldStart }]
    : [{ flex: 1 }];
  const paneColumns = split
    ? columnsFor(Math.min(foldStart, grid.width - foldEnd))
    : columnsFor(width);

  return (
    <Screen title="Home">
      <View ref={gridRef} style={styles.grid}>
        {panes.map((paneStyle, paneIndex) => (
          <View key={paneIndex} testID="pane" style={[styles.pane, paneStyle]}>
            {cardTitles
              .filter(
                (_, cardIndex) =>
                  Math.floor((cardIndex % (paneColumns * panes.length)) / paneColumns) === paneIndex
              )
              .map((cardTitle) => (
                <View
                  key={cardTitle}
                  testID="card"
                  style={[styles.cell, { width: `${100 / paneColumns}%` }]}
                >
                  <View
                    style={[
                      styles.card,
                      { backgroundColor: colors.card, borderColor: colors.border }
                    ]}
                  >
                    <Text style={[styles.cardTitle, { color: colors.text }]}>{cardTitle}</Text>
                  </View>
                </View>
              ))}
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', margin: -8 },
  pane: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { padding: 8 },
  card: { minHeight: 96, padding: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  cardTitle: { fontSize: 17, fontWeight: '600' }
});
