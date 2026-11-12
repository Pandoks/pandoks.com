# React Native Watch

Phone side of the watch bridge, an [Expo module](https://docs.expo.dev/modules/module-api) with one
JS API and a native adapter per platform:
[WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity) on iOS and the
[Wearable Data Layer](https://developer.android.com/training/wearables/data/overview) on Android.
The watch side lives in the app, like `templates/mobile/targets/watch` (watchOS) and
`templates/mobile/targets/wear` (Wear OS).

`Watch` is `null` on iPads, which can't pair a watch. Otherwise it has:

- `updateApplicationContext(context)`: replaces the state the watch reads, even if it launches
  later. On iOS it waits for the session to activate, then rejects if no watch with the app is
  paired; on Android it rejects when the Wearable API is unavailable and otherwise queues until a
  watch connects.
- `isReachable` and the `onReachabilityChange` event: on iOS, whether the watch app is running and
  connected; on Android, whether a connected watch has the Wear OS app installed.
- `receivedApplicationContext` and the `onApplicationContext` event: the latest state the watch sent
  with `updateApplicationContext`, delivered even if the phone app wasn't running.

Read events with `useEvent(Watch, 'onApplicationContext', Watch.receivedApplicationContext)` from
`expo`.

On Android, the config plugin adds a Wear OS app as the `:wear` Gradle module, from a directory
relative to the app root: `["@pandoks.com/react-native-watch", { "wearApp": "./targets/wear" }]`.
That app must reuse the phone app's application ID and signing key, declare the `watch_app`
capability in `android_wear_capabilities`, read the phone's context from the `/phone_context` data
item, and write its own to `/watch_context` as a `context` `DataMap` beside a `sentAt` time in epoch
milliseconds, which the phone uses to keep the newest value across watches.
