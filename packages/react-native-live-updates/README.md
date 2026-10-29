# @pandoks.com/react-native-live-updates

A progress activity with one API on both platforms: an iOS Live Activity (Lock Screen and Dynamic
Island, through `expo-widgets`) and an Android Live Update (a promoted `ProgressStyle` notification
on Android 16+, a plain ongoing progress notification before). The system fills the progress bar
from `startedAt` to `endsAt` on its own, so it keeps moving while the app is suspended.

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

iOS pushes use `apns-push-type: liveactivity`, topic `<bundle id>.push-type.liveactivity`, and
`content-state` `{ "name": "ProgressActivity", "props": "<JSON state>" }`.
