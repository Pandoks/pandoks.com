import { usePosture, useReservedRegions } from '@pandoks.com/react-native-reserved-regions';
import { useHinge } from 'expo-hinge';
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
  const regions = useReservedRegions({ includeInactive: true });
  const posture = usePosture();
  const hinge = useHinge();

  const rows = [
    ['Color scheme', colorScheme],
    ['Window', `${Math.round(width)} × ${Math.round(height)}`],
    ['Font scale', fontScale.toFixed(2)],
    ['Safe area', [insets.top, insets.right, insets.bottom, insets.left].map(Math.round).join(' ')],
    ['Platform', `${Platform.OS} ${Platform.Version}`],
    ['Posture', posture],
    ['Hinge', hinge ? `${Math.round(hinge.angle)}° ${hinge.status}` : 'None'],
    ...regions.map(({ kind, frame, active }) => [
      `${kind === 'division' ? 'Division' : 'Occlusion'}${active ? '' : ' (inactive)'}`,
      `${Math.round(frame.x)}, ${Math.round(frame.y)} ${Math.round(frame.width)} × ${Math.round(frame.height)}`
    ])
  ];

  return (
    <Screen title="Device">
      <View style={[styles.list, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {rows.map(([label, value], index) => (
          <View
            key={index}
            style={[styles.row, index === 0 && styles.firstRow, { borderColor: colors.border }]}
          >
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
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 16,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth
  },
  firstRow: { borderTopWidth: 0 },
  label: { fontSize: 17 },
  value: { fontSize: 17, opacity: 0.6, fontVariant: ['tabular-nums'] }
});
