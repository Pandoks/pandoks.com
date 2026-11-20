# React Native Watch

Phone side of the Apple Watch bridge, an [Expo module](https://docs.expo.dev/modules/module-api)
over [WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity). The watch
side lives in the app's watchOS target, like `templates/mobile/targets/watch`.

`Watch` is `null` on Android until Wear OS support, and on iPads, which can't pair a watch.
Otherwise it has:

- `updateApplicationContext(context)`: replaces the state the watch reads, even if it launches
  later. It waits for the session to activate, then rejects if activation fails or no watch with the
  app is paired.
- `isReachable` and the `onReachabilityChange` event: whether the watch app is running and
  connected.
- `receivedApplicationContext` and the `onApplicationContext` event: the latest state the watch sent
  with `updateApplicationContext`, delivered even if the phone app wasn't running.

Read events with `useEvent(Watch, 'onApplicationContext', Watch.receivedApplicationContext)` from
`expo`.
