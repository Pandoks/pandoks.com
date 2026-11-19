import { Dimensions, type StyleProp, StyleSheet, type ViewStyle } from 'react-native';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import HomeScreen from '@/app/index';

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

test('lays out the pane beside an iPad sidebar by its own width', async () => {
  Dimensions.set({ window: { width: 1133, height: 744, scale: 2, fontScale: 1 } });

  await renderRouter({ index: HomeScreen });
  await fireEvent(screen.getByTestId('pane'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 810, height: 744 } }
  });

  const { width: cardWidth } = StyleSheet.flatten(
    screen.getAllByTestId('card')[0].props.style as StyleProp<ViewStyle>
  )!;
  expect(100 / Number.parseFloat(String(cardWidth))).toBeCloseTo(2);
});
