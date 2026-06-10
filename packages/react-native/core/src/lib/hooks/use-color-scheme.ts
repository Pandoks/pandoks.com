import { useColorScheme as useRawColorScheme } from 'react-native';

export function useColorScheme(): 'light' | 'dark' {
  const scheme = useRawColorScheme();
  return scheme === 'dark' ? 'dark' : 'light';
}
