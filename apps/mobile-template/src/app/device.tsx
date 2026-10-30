import { type StoreUpdate, StoreUpdates } from '@pandoks.com/react-native-store-updates';
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
  const [storeUpdate, setStoreUpdate] = useState<StoreUpdate>();
  const [storeUpdateError, setStoreUpdateError] = useState<string>();

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
        <Pressable
          style={({ pressed }) => [
            styles.row,
            { borderColor: colors.border, opacity: pressed ? 0.5 : 1 }
          ]}
          onPress={async () => {
            setStoreUpdateError(undefined);
            try {
              if (storeUpdate?.available) await StoreUpdates.startStoreUpdate('immediate');
              else setStoreUpdate(await StoreUpdates.checkForStoreUpdate());
            } catch (error) {
              setStoreUpdateError((error as Error).message);
            }
          }}
        >
          <Text style={[styles.label, { color: colors.primary }]}>
            {storeUpdate?.available ? 'Update' : 'Check for update'}
          </Text>
          <Text style={[styles.value, { color: colors.text }]}>
            {storeUpdateError ??
              (storeUpdate && (storeUpdate.available ? storeUpdate.storeVersion : 'Up to date'))}
          </Text>
        </Pressable>
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
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  label: { fontSize: 17 },
  value: { fontSize: 17, opacity: 0.6, fontVariant: ['tabular-nums'] }
});
