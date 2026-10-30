import { useTheme } from 'expo-router';
import {
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  useWindowDimensions,
  View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Screen } from '../components/screen';

export default function DeviceScreen() {
  const colorScheme = useColorScheme();
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  const rows = [
    ['Color scheme', colorScheme],
    ['Window', `${Math.round(width)} × ${Math.round(height)}`],
    ['Font scale', fontScale.toFixed(2)],
    ['Safe area', [insets.top, insets.right, insets.bottom, insets.left].map(Math.round).join(' ')],
    ['Platform', `${Platform.OS} ${Platform.Version}`]
  ];

  return (
    <Screen title="Device">
      <View style={[styles.list, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {rows.map(([label, value]) => (
          <View key={label} style={[styles.row, { borderColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
            <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  label: { fontSize: 17 },
  value: { fontSize: 17, opacity: 0.6, fontVariant: ['tabular-nums'] }
});
