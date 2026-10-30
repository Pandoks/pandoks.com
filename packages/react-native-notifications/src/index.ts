import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

const CHANNEL_ID = 'default';

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false
    })
});

// NOTE: Android 13+ shows the permission prompt and issues push tokens only once a channel exists
const channelCreated = Notifications.setNotificationChannelAsync(CHANNEL_ID, {
  name: 'Notifications',
  importance: Notifications.AndroidImportance.HIGH
});

export function useNotificationPermission() {
  const [permission, setPermission] = useState<Notifications.NotificationPermissionsStatus>();

  useEffect(() => {
    function readPermission() {
      void Notifications.getPermissionsAsync().then(setPermission);
    }

    readPermission();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') readPermission();
    });
    return () => subscription.remove();
  }, []);

  async function requestPermission() {
    await channelCreated;
    setPermission(await Notifications.requestPermissionsAsync());
  }

  return [permission, requestPermission] as const;
}

/** Opens the Expo Router path in a tapped notification's `url` data. */
export function useNotificationRouting() {
  useEffect(() => {
    function openUrl(response: Notifications.NotificationResponse | null) {
      const url = response?.notification.request.content.data?.url;
      if (!url) return;
      router.push(url as Href);
      Notifications.clearLastNotificationResponse();
    }

    openUrl(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(openUrl);
    return () => subscription.remove();
  }, []);
}

export function useDevicePushToken() {
  const [devicePushToken, setDevicePushToken] = useState<{ token?: string; error?: Error }>({});

  useEffect(() => {
    channelCreated
      .then(() => Notifications.getDevicePushTokenAsync())
      .then(
        (pushToken) => setDevicePushToken({ token: pushToken.data as string }),
        (error: Error) => setDevicePushToken({ error })
      );
    const subscription = Notifications.addPushTokenListener((pushToken) =>
      setDevicePushToken({ token: pushToken.data as string })
    );
    return () => subscription.remove();
  }, []);

  return devicePushToken;
}

// NOTE: simulator and development-signed builds use the APNs sandbox; store builds embed no profile
async function getApnsEnvironment() {
  const releaseType = await Application.getIosApplicationReleaseTypeAsync();
  return releaseType === Application.ApplicationReleaseType.SIMULATOR ||
    releaseType === Application.ApplicationReleaseType.DEVELOPMENT
    ? 'sandbox'
    : 'production';
}

export async function registerDevice({
  backendUrl,
  token,
  headers
}: {
  backendUrl: string;
  token: string;
  headers?: Record<string, string>;
}) {
  const response = await fetch(`${backendUrl}/devices/${token}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      platform: Platform.OS,
      app: Application.applicationId,
      kind: 'device',
      apns_environment: Platform.OS === 'ios' ? await getApnsEnvironment() : undefined
    })
  });
  if (!response.ok) throw new Error(`Registering the device failed with ${response.status}`);
}

export async function unregisterDevice({
  backendUrl,
  token,
  headers
}: {
  backendUrl: string;
  token: string;
  headers?: Record<string, string>;
}) {
  const response = await fetch(`${backendUrl}/devices/${token}`, { method: 'DELETE', headers });
  if (!response.ok) throw new Error(`Unregistering the device failed with ${response.status}`);
}

/**
 * Schedules a local notification at a date, in some seconds, or daily at a time. Android without
 * the exact alarm permission delivers it at an approximate time.
 */
export function scheduleNotification({
  title,
  body,
  url,
  trigger
}: {
  title: string;
  body?: string;
  url?: Href;
  trigger: { date: Date } | { seconds: number } | { hour: number; minute: number };
}) {
  const { DATE, TIME_INTERVAL, DAILY } = Notifications.SchedulableTriggerInputTypes;
  return Notifications.scheduleNotificationAsync({
    content: { title, body, data: { url } },
    trigger:
      'date' in trigger
        ? { type: DATE, channelId: CHANNEL_ID, ...trigger }
        : 'seconds' in trigger
          ? { type: TIME_INTERVAL, channelId: CHANNEL_ID, ...trigger }
          : { type: DAILY, channelId: CHANNEL_ID, ...trigger }
  });
}
