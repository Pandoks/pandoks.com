# React Native Watch

Phone side of the watch bridge, an [Expo module](https://docs.expo.dev/modules/module-api) with one
JS API and a native adapter per platform:
[WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity) on iOS and the
[Wearable Data Layer](https://developer.android.com/training/wearables/data/overview) on Android.
The watch side lives in the app, like `apps/mobile-template/targets/watch` (watchOS) and
`apps/mobile-template/targets/wear` (Wear OS).

`Watch` is `null` on iPads, which can't pair a watch. Otherwise it has:

- `updateApplicationContext(context)`: replaces the state the watch reads, even if it launches
  later. It throws when no watch is paired, and on iOS when the watch app isn't installed.
- `isReachable` and the `onReachabilityChange` event: on iOS, whether the watch app is running and
  connected; on Android, whether a connected watch has the Wear OS app installed.
- the `onMessage` event: each dictionary the watch sends with `sendMessage`.

Read events with `useEvent(Watch, 'onMessage')` from `expo`.

On Android, the config plugin adds a Wear OS app as the `:wear` Gradle module, from a directory
relative to the app root: `["@pandoks.com/react-native-watch", { "wearApp": "./targets/wear" }]`.
That app must reuse the phone app's application ID and signing key, declare the `watch_app`
capability in `android_wear_capabilities`, read the context from the `/application_context` data
item, and send `DataMap` messages to `/message`.
