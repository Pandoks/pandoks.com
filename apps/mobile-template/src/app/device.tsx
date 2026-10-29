import { useTheme } from 'expo-router';
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
import {
  scheduleNotification,
  useDevicePushToken,
  useNotificationPermission
} from '@pandoks.com/react-native-notifications';

import { Screen } from '../components/screen';

export default function DeviceScreen() {
  const colorScheme = useColorScheme();
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [permission, requestPermission] = useNotificationPermission();
  const { token, error } = useDevicePushToken();

  const rows = [
    ['Color scheme', colorScheme],
    ['Window', `${Math.round(width)} × ${Math.round(height)}`],
    ['Font scale', fontScale.toFixed(2)],
    ['Safe area', [insets.top, insets.right, insets.bottom, insets.left].map(Math.round).join(' ')],
    ['Platform', `${Platform.OS} ${Platform.Version}`],
    ['Notifications', permission?.status],
    ['Push token', token ?? error?.message]
  ];
  const actions = [
    { label: 'Allow notifications', onPress: requestPermission },
    {
      label: 'Notify in 5 seconds',
      onPress: () =>
        scheduleNotification({
          title: 'Mobile Template',
          body: 'Tap to open the Device tab',
          url: '/device',
          trigger: { seconds: 5 }
        })
    }
  ];
  const listStyle = [styles.list, { backgroundColor: colors.card, borderColor: colors.border }];

  return (
    <Screen title="Device">
      <View style={listStyle}>
        {rows.map(([label, value]) => (
          <View key={label} style={[styles.row, { borderColor: colors.border }]}>
            <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
            <Text
              style={[styles.value, { color: colors.text }]}
              numberOfLines={1}
              ellipsizeMode="middle"
              selectable
            >
              {value}
            </Text>
          </View>
        ))}
      </View>
      <View style={listStyle}>
        {actions.map(({ label, onPress }) => (
          <Pressable
            key={label}
            role="button"
            onPress={() => void onPress()}
            style={({ pressed }) => [
              styles.row,
              { borderColor: colors.border, opacity: pressed ? 0.5 : 1 }
            ]}
          >
            <Text style={[styles.label, { color: colors.primary }]}>{label}</Text>
          </Pressable>
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
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  label: { fontSize: 17 },
  value: { flexShrink: 1, fontSize: 17, opacity: 0.6, fontVariant: ['tabular-nums'] }
});
