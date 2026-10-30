import { type ReservedRegion } from '@pandoks.com/react-native-reserved-regions';
import { type ComponentRef } from 'react';
import { Dimensions, View } from 'react-native';
import { fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import HomeScreen from '../app/index';

let mockRegions: ReservedRegion[] = [];
jest.mock('@pandoks.com/react-native-reserved-regions', () => ({
  useReservedRegions: () => mockRegions
}));

// NOTE: the jest preset mocks View as a class whose instances share these methods
const viewPrototype = (View as unknown as { prototype: ComponentRef<typeof View> }).prototype;

beforeEach(() => {
  mockRegions = [];
  jest.restoreAllMocks();
});

test.each([
  [390, '100%'],
  [700, '50%'],
  [1024, `${100 / 3}%`]
])('lays out cards for a %dpt wide window at %s width', async (width, cardWidth) => {
  Dimensions.set({ window: { width, height: 800, scale: 2, fontScale: 1 } });

  await renderRouter({ index: HomeScreen });

  expect(screen.getAllByTestId('card')[0]).toHaveStyle({ width: cardWidth });
});

test('splits the columns at a vertical fold so no card straddles it', async () => {
  Dimensions.set({ window: { width: 852, height: 883, scale: 2, fontScale: 1 } });
  mockRegions = [
    { kind: 'division', frame: { x: 426, y: 0, width: 0, height: 883 }, active: false }
  ];
  jest
    .spyOn(viewPrototype, 'measureInWindow')
    .mockImplementation((callback) => callback(8, 100, 836, 400));

  await renderRouter({ index: HomeScreen });

  const [leftPane, rightPane] = screen.getAllByTestId('pane');
  expect(leftPane).toHaveStyle({ width: 418 });
  expect(screen.getAllByTestId('card')[0]).toHaveStyle({ width: '100%' });
  for (const cardTitle of ['Inbox', 'Upcoming', 'Archive']) {
    expect(within(leftPane).getByText(cardTitle)).toBeOnTheScreen();
  }
  for (const cardTitle of ['Today', 'Projects', 'Trash']) {
    expect(within(rightPane).getByText(cardTitle)).toBeOnTheScreen();
  }
});

test('measures the grid again when safe area insets move it', async () => {
  Dimensions.set({ window: { width: 852, height: 883, scale: 2, fontScale: 1 } });
  mockRegions = [
    { kind: 'division', frame: { x: 426, y: 0, width: 0, height: 883 }, active: false }
  ];
  let gridX = 8;
  jest
    .spyOn(viewPrototype, 'measureInWindow')
    .mockImplementation((callback) => callback(gridX, 100, 844 - gridX, 400));

  await renderRouter({ index: HomeScreen });
  gridX = 38;
  await fireEvent(screen.root!, 'insetsChange', {
    nativeEvent: {
      insets: { top: 0, right: 0, bottom: 0, left: 30 },
      frame: { x: 0, y: 0, width: 852, height: 883 }
    }
  });

  expect(screen.getAllByTestId('pane')[0]).toHaveStyle({ width: 388 });
});
