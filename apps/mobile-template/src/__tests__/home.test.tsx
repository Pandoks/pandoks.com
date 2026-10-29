import { Dimensions } from 'react-native';
import { renderRouter, screen } from 'expo-router/testing-library';

import HomeScreen from '../app/index';

test.each([
  [390, '100%'],
  [700, '50%'],
  [1024, `${100 / 3}%`]
])('lays out cards for a %dpt wide window at %s width', async (width, cardWidth) => {
  Dimensions.set({ window: { width, height: 800, scale: 2, fontScale: 1 } });

  await renderRouter({ index: HomeScreen });

  expect(screen.getAllByTestId('card')[0]).toHaveStyle({ width: cardWidth });
});
