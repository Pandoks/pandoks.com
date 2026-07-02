# @pandoks.com/react-native-live-updates-android

The Android analog of iOS Live Activities: **Live Updates** — Android
16's promoted, ongoing `ProgressStyle`/chronometer notifications
(`developer.android.com/develop/ui/views/notifications/live-update`).
Rolled by hand because ActivityKit has no Android counterpart and
`expo-widgets` ships nothing for it.

Where iOS Live Activities render arbitrary UI trees, Android Live
Updates are **notification-template-based**: title/text, a natively
ticking chronometer, a segmented progress bar, action buttons, and a
status-bar chip while promoted. That's the parity ceiling — by OS
design, not by this module.

## How it works

- One notification per live update, tagged `live-update:<name>` —
  `getActiveLiveUpdates()` reads them back from the OS, so state
  survives JS reloads (same adoption model as ActivityKit's
  `getInstances()`).
- Notifications are built with `NotificationCompat` (androidx.core
  1.19) and request promotion via `setRequestPromotedOngoing(true)`;
  on Android < 16 the same call posts a plain ongoing notification —
  graceful degradation, no branching needed in app code.
- Action buttons broadcast to a library-declared receiver **in the app
  process**, which forwards `{source, target}` to JS via
  `addLiveUpdateInteractionListener` — the same event shape as
  `expo-widgets` and `widget-android`.
- **No config plugin**: permissions (`POST_NOTIFICATIONS`,
  `POST_PROMOTED_NOTIFICATIONS`) and the action receiver live in this
  library's own `AndroidManifest.xml` and merge into the app manifest
  automatically. Install + autolink is the whole setup.

## Usage

Screens normally go through `useLiveActivity` (core), which branches to
this module on Android via its `android.config` translator. Direct API:

```ts
import {
  addLiveUpdateInteractionListener,
  endLiveUpdate,
  requestLiveUpdatePermissions,
  startLiveUpdate
} from '@pandoks.com/react-native-live-updates-android';

await requestLiveUpdatePermissions(); // POST_NOTIFICATIONS (runtime, API 33+)
await startLiveUpdate('Focus', {
  title: 'Deep work',
  chronometer: { startedAt: Date.now() }, // ticks natively, zero updates needed
  actions: [{ target: 'stop', label: 'End session' }],
  deepLink: 'mobiletemplate://native/live-activity'
});
const subscription = addLiveUpdateInteractionListener(({ source, target }) => {});
await endLiveUpdate('Focus');
```

## Caveats

- Promotion (status-bar chip, elevated placement) requires Android 16+
  AND the user allowing promoted notifications
  (`canPromoteLiveUpdates()` to check); otherwise it's a normal
  ongoing notification.
- Like iOS Live Activity buttons, action taps only reach JS while the
  app's JS runtime is alive — the receiver runs in the app process
  (Android spawns it for the broadcast if needed), but a headless
  process has no JS listener to hand the event to.
- OEM skins may gate promoted notifications differently; the emulator
  (AOSP/Pixel) is the reference behavior.
