# @pandoks.com/react-native-live-updates

A progress activity with one API on both platforms: an iOS Live Activity (Lock Screen and Dynamic
Island, through `expo-widgets`) and an Android Live Update (a promoted `ProgressStyle` notification
on Android 16+, a plain ongoing progress notification before). The countdown runs on its own on
both. iOS also fills the progress bar while the app is suspended, shows Done at `endsAt` (in the
simulator, no sooner than 2 minutes after it starts), and keeps the activity until the app or an
`end` push ends it: `end(finalState)` leaves it on the Lock Screen for the system's default
dismissal, and `end()` removes it now. Android's bar moves only on `update`, and on Android 8+ the
system removes the notification at `endsAt`; before that the user can dismiss it. Android widgets
have no timeline, so the app's home screen widgets rerender when the notification goes away, letting
them show their end state without the app. If the user dismisses it early, an inexact alarm
rerenders them at `endsAt`; Android may deliver it up to an hour late, or after Doze ends.

The app needs the `expo-widgets` config plugin; set `enablePushNotifications` for iOS push tokens.
`startProgressActivity` rejects when the user turned off Live Activities, notifications, or the Live
updates channel. On Android, request `POST_NOTIFICATIONS` (`PermissionsAndroid.request`) before
picking `startedAt`, so time spent on the prompt doesn't come out of the activity. Activities
outlive the app process, so `getProgressActivities()` returns the running ones (on Android 8+) to
update or end after a relaunch.

```ts
import { startProgressActivity } from '@pandoks.com/react-native-live-updates';
import { PermissionsAndroid, Platform } from 'react-native';

if (Platform.OS === 'android') {
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}
const startedAt = Date.now();
const activity = await startProgressActivity({
  title: 'Focus',
  text: 'Stay on task',
  startedAt,
  endsAt: startedAt + 30_000
});
activity.addPushTokenListener((pushToken) => {}); // iOS only
await activity.update({
  title: 'Focus',
  text: 'Ten more seconds',
  startedAt,
  endsAt: startedAt + 40_000
});
await activity.end(); // or end(finalState) once it finished
```

iOS pushes use `apns-push-type: liveactivity` and topic `<bundle id>.push-type.liveactivity`.
`event` is `update` or `end`; `timestamp` and `stale-date` are seconds, `props` times milliseconds:

```json
{
  "aps": {
    "timestamp": 1767225610,
    "event": "update",
    "stale-date": 1767225640,
    "content-state": {
      "name": "ProgressActivity",
      "props": "{\"title\":\"Focus\",\"text\":\"Ten more seconds\",\"startedAt\":1767225600000,\"endsAt\":1767225640000}"
    }
  }
}
```
