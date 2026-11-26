import {
  getProgressActivities,
  startProgressActivity,
  type ProgressActivity,
  type ProgressActivityState
} from '@pandoks.com/react-native-live-updates';
import { type EventSubscription } from 'expo';
import { useTheme } from 'expo-router';
import { useEffect, useState } from 'react';
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '../components/screen';
import FocusWidget from '../widgets/focus-widget';

const SESSION_MS = 30_000;
const EXTEND_MS = 10_000;

type Session = {
  activity: ProgressActivity;
  state: ProgressActivityState;
  pushTokenSubscription: EventSubscription;
};

function formatTime(epochMs: number) {
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function endSession(
  session: Session,
  title: string,
  endedAt: number,
  finalState?: ProgressActivityState
) {
  session.pushTokenSubscription.remove();
  FocusWidget.updateSnapshot({ title, caption: `At ${formatTime(endedAt)}` });
  await session.activity.end(finalState);
}

function showFocusing(endsAt: number) {
  const focusing = { title: 'Focusing', caption: `Until ${formatTime(endsAt)}` };
  const done = { title: 'Done', caption: `At ${formatTime(endsAt)}` };
  if (Platform.OS === 'android') {
    FocusWidget.updateSnapshot({ ...focusing, next: { date: endsAt, ...done } });
    return;
  }
  FocusWidget.updateTimeline([
    { date: new Date(), props: focusing },
    { date: new Date(endsAt), props: done }
  ]);
}

export default function FocusScreen() {
  const { colors } = useTheme();
  const [session, setSession] = useState<Session | null>(null);
  const [now, setNow] = useState(Date.now);
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // NOTE: Start waits for leftovers to end, or their widget cleanup would overwrite the new session's
  const [recovering, setRecovering] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    void getProgressActivities()
      .then(async (activities) => {
        if (activities.length === 0) {
          return;
        }
        // NOTE: iOS can't read a recovered activity's endsAt, but the widget's last timeline entry is its Done
        const endsAt = Math.max(
          ...(Platform.OS === 'android'
            ? activities.map((activity) => activity.endsAt ?? 0)
            : (await FocusWidget.getTimeline()).map((entry) => entry.date.getTime()))
        );
        const now = Date.now();
        FocusWidget.updateSnapshot(
          endsAt > now
            ? { title: 'Stopped', caption: `At ${formatTime(now)}` }
            : { title: 'Done', caption: `At ${formatTime(endsAt)}` }
        );
        await Promise.all(activities.map((activity) => activity.end()));
      })
      .finally(() => setRecovering(false));
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const finish = setTimeout(() => {
      setSession(null);
      void endSession(session, 'Done', session.state.endsAt, session.state);
    }, session.state.endsAt - Date.now());
    return () => {
      clearInterval(tick);
      clearTimeout(finish);
    };
  }, [session]);

  async function start() {
    setStarting(true);
    try {
      if (Platform.OS === 'android') {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      }
      const startedAt = Date.now();
      const state = {
        title: 'Focus',
        text: 'Stay on task',
        startedAt,
        endsAt: startedAt + SESSION_MS
      };
      const activity = await startProgressActivity(state);
      setPushToken(null);
      setNow(startedAt);
      setSession({
        activity,
        state,
        pushTokenSubscription: activity.addPushTokenListener(setPushToken)
      });
      void activity.getPushToken().then((token) => token && setPushToken(token));
      showFocusing(state.endsAt);
      setStartError(null);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  async function extend(current: Session) {
    const state = {
      ...current.state,
      text: 'Ten more seconds',
      endsAt: current.state.endsAt + EXTEND_MS
    };
    setSession({ ...current, state });
    showFocusing(state.endsAt);
    await current.activity.update(state);
  }

  const remainingSeconds = Math.ceil(
    (session ? Math.max(0, session.state.endsAt - now) : SESSION_MS) / 1000
  );

  return (
    <Screen title="Focus">
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.timer, { color: colors.text }]}>
          {`${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`}
        </Text>
        <Text style={[styles.caption, { color: colors.text }]}>
          {session?.state.text ??
            startError ??
            'Follow it from the Lock Screen and the Focus widget.'}
        </Text>
        <View style={styles.actions}>
          {session ? (
            <>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, { backgroundColor: colors.border }]}
                onPress={() => extend(session)}
              >
                <Text style={[styles.buttonLabel, { color: colors.text }]}>+10 s</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, { backgroundColor: colors.border }]}
                onPress={() => {
                  setSession(null);
                  void endSession(session, 'Stopped', Date.now());
                }}
              >
                <Text style={[styles.buttonLabel, { color: colors.text }]}>Stop</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              disabled={starting || recovering}
              style={[styles.button, { backgroundColor: colors.primary }]}
              onPress={start}
            >
              <Text style={[styles.buttonLabel, { color: 'white' }]}>Start</Text>
            </Pressable>
          )}
        </View>
        {session && pushToken && (
          <Text numberOfLines={1} style={[styles.caption, { color: colors.text }]}>
            {`Push token ${pushToken}`}
          </Text>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
  timer: { fontSize: 64, fontWeight: '200', fontVariant: ['tabular-nums'] },
  caption: { fontSize: 15, opacity: 0.6 },
  actions: { flexDirection: 'row', gap: 12 },
  button: { flex: 1, alignItems: 'center', padding: 14, borderRadius: 12 },
  buttonLabel: { fontSize: 17, fontWeight: '600' }
});
