# React Native Watch

Phone side of the Apple Watch bridge, an [Expo module](https://docs.expo.dev/modules/module-api)
over [WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity). The watch
side lives in the app's watchOS target, like `apps/mobile-template/targets/watch`.

`Watch` is `null` on Android until Wear OS support, and on iPads, which can't pair a watch.
Otherwise it has:

- `updateApplicationContext(context)`: replaces the state the watch reads, even if it launches
  later.
- `isReachable` and the `onReachabilityChange` event: whether the watch app is running and
  connected.
- the `onMessage` event: each dictionary the watch sends with `sendMessage`.

Read events with `useEvent(Watch, 'onMessage')` from `expo`.
