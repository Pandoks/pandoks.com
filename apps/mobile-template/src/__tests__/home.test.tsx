import { Dimensions, type StyleProp, StyleSheet, type ViewStyle } from 'react-native';
import { renderRouter, screen } from 'expo-router/testing-library';

import HomeScreen from '../app/index';

test.each([
  [599, 1],
  [600, 2],
  [839, 2],
  [840, 3]
])('lays out a %dpt wide window in %d columns', async (width, columns) => {
  Dimensions.set({ window: { width, height: 800, scale: 2, fontScale: 1 } });

  await renderRouter({ index: HomeScreen });

  const { width: cardWidth } = StyleSheet.flatten(
    screen.getAllByTestId('card')[0].props.style as StyleProp<ViewStyle>
  )!;
  expect(100 / Number.parseFloat(String(cardWidth))).toBeCloseTo(columns);
});
