import { useColorScheme } from 'react-native';
import { Colors } from '../constants/theme';

// https://docs.expo.dev/guides/color-schemes/
export function useTheme() {
  const scheme = useColorScheme();

  return Colors[scheme === 'dark' ? 'dark' : 'light'];
}
