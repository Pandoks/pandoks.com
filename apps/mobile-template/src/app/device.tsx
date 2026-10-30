import { Watch } from '@pandoks.com/react-native-watch';
import { useEvent } from 'expo';
import { useTheme } from 'expo-router';
import { useState } from 'react';
import {
  Platform,
  Pressable,
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
        {rows.map(([label, value], index) => (
          <View
            key={label}
            style={[styles.row, index === 0 && styles.firstRow, { borderColor: colors.border }]}
          >
            <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
            <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
          </View>
        ))}
        {Watch && <WatchRows watch={Watch} />}
      </View>
    </Screen>
  );
}

function WatchRows({ watch }: { watch: NonNullable<typeof Watch> }) {
  const { colors } = useTheme();
  const { isReachable } = useEvent(watch, 'onReachabilityChange', {
    isReachable: watch.isReachable
  });
  const messageFromWatch = useEvent(watch, 'onMessage');
  const [sendError, setSendError] = useState<string | null>(null);

  function sendToWatch() {
    try {
      watch.updateApplicationContext({ value: new Date().toLocaleTimeString() });
      setSendError(null);
    } catch (error) {
      // NOTE: throws when no watch is paired, and on iOS when the watch app isn't installed
      setSendError(String(error));
    }
  }

  return (
    <>
      <View style={[styles.row, { borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.text }]}>Watch</Text>
        <Text style={[styles.value, { color: colors.text }]}>
          {sendError ?? (isReachable ? 'Reachable' : 'Not reachable')}
        </Text>
      </View>
      <Pressable style={[styles.row, { borderColor: colors.border }]} onPress={sendToWatch}>
        <Text style={[styles.label, { color: colors.primary }]}>Send to watch</Text>
        <Text style={[styles.value, { color: colors.text }]}>
          {messageFromWatch?.value ?? 'Nothing from watch'}
        </Text>
      </Pressable>
    </>
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
