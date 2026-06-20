import { render, screen } from '@testing-library/react-native';

import NativeDemosScreen from '../app/native';

describe('NativeDemosScreen', () => {
  it('renders the screen title', () => {
    render(<NativeDemosScreen />);
    expect(screen.getByText('Native')).toBeOnTheScreen();
  });

  it('lists the image-classify demo card', () => {
    render(<NativeDemosScreen />);
    expect(screen.getByText('Image classify (custom module)')).toBeOnTheScreen();
  });
});
