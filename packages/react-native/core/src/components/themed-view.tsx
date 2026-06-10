import { View, type ViewProps } from 'react-native';

import { type ThemeColor } from '../lib/constants/theme';
import { useTheme } from '../lib/hooks/use-theme';

export type ThemedViewProps = ViewProps & {
  type?: ThemeColor;
};

export function ThemedView({ style, type, ...otherProps }: ThemedViewProps) {
  const theme = useTheme();

  return <View style={[{ backgroundColor: theme[type ?? 'background'] }, style]} {...otherProps} />;
}
