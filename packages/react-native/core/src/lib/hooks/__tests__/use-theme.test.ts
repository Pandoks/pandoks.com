import { renderHook } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

import { Colors } from '../../constants/theme';
import { useTheme } from '../use-theme';

describe('useTheme', () => {
  const useColorScheme = jest.spyOn(ReactNative, 'useColorScheme');

  afterEach(() => useColorScheme.mockReset());

  it('returns the dark palette when the scheme is dark', () => {
    useColorScheme.mockReturnValue('dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(Colors.dark);
  });

  it('returns the light palette when the scheme is light', () => {
    useColorScheme.mockReturnValue('light');
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(Colors.light);
  });

  it('falls back to the light palette when the scheme is null', () => {
    useColorScheme.mockReturnValue(null as unknown as ReactNative.ColorSchemeName);
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe(Colors.light);
  });
});
