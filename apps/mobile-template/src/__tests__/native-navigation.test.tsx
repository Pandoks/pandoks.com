import { renderRouter, screen } from 'expo-router/testing-library';
import { fireEvent } from '@testing-library/react-native';

import NativeDemosScreen from '../app/native';

it('navigates from the Native list to the image-classify demo', () => {
  renderRouter(
    {
      'native/index': NativeDemosScreen,
      'native/image-classify': () => null
    },
    { initialUrl: '/native' }
  );

  expect(screen).toHavePathname('/native');

  fireEvent.press(screen.getByText('Image classify (custom module)'));

  expect(screen).toHavePathname('/native/image-classify');
});
