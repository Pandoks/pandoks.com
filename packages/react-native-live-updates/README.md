# @pandoks.com/react-native-live-updates

A progress activity with one API on both platforms: an iOS Live Activity (Lock Screen and Dynamic
Island, through `expo-widgets`) and an Android Live Update (a promoted `ProgressStyle` notification
on Android 16+, a plain ongoing progress notification before). The countdown runs on its own on
both. iOS also fills the progress bar while the app is suspended and shows Done at `endsAt`, but
only the app or an `end` push removes the activity. Android's bar moves only on `update`, and on
Android 8+ the system removes the notification at `endsAt`; before that the user can dismiss it.

The app needs the `expo-widgets` config plugin; set `enablePushNotifications` for iOS push tokens.

```ts
import { startProgressActivity } from '@pandoks.com/react-native-live-updates';

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
await activity.end();
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
