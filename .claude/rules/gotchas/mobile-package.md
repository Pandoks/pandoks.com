---
paths:
  - 'packages/react-native/**'
---

# Adding native capability to a mobile app in this monorepo

## Philosophy

Use first-party Expo modules where they exist. Use mature OSS libraries where Expo doesn't cover. Write your own native module only as a last resort — scaffolds in this repo demonstrate the integration pattern, not bespoke native code.

The mobile-template shows the full stack:

| Capability                             | What we use                                                                                                                               | Why                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS home-screen widget + Live Activity | `expo-widgets` (TS-authored widgets)                                                                                                      | First-party, stable in SDK 56. Write the widget in TypeScript, not SwiftUI.                                                                                  |
| Apple Watch app                        | `@bacons/apple-targets` + raw SwiftUI + `WatchConnectivity`                                                                               | Expo has no watchOS. apple-targets generates the Xcode target; you write the SwiftUI yourself.                                                               |
| Wear OS app                            | Sibling `:wear` Gradle module + Compose-for-Wear + Wear Data Layer                                                                        | Expo has no Wear OS. We scaffold the Gradle module ourselves via a local config plugin.                                                                      |
| Phone ↔ watch sync                     | `react-native-watch-connectivity` (iOS) + `react-native-wear-connectivity` (Android), wrapped in `@pandoks.com/react-native-watch-bridge` | The two libs intentionally mirror each other's API; the bridge picks the right one via `Platform.OS`.                                                        |
| Camera + frame processing              | `react-native-vision-camera` v5 (Nitro-based)                                                                                             | First-party Expo `expo-camera` doesn't expose per-frame access. Vision-camera v5 uses an outputs-model: `usePreviewOutput()`, `useFrameOutput({ onFrame })`. |
| Face detection                         | `react-native-vision-camera-face-detector` v2                                                                                             | Plugs into vision-camera v5; uses Vision (iOS) / ML Kit (Android) under the hood.                                                                            |
| Haptics (basic)                        | `expo-haptics`                                                                                                                            | First-party. Good enough for impact + notification feedback.                                                                                                 |
| Haptics (rich)                         | `react-native-haptic-feedback`                                                                                                            | Adds rigid/soft + cross-platform AHAP via `playAHAP()`.                                                                                                      |

## Layouts in this monorepo

App-tied native targets stay in the app (welded into its Xcode/Gradle build).
Shareable native modules + plugins live in `packages/react-native/`. The dir
naming is platform-prefixed: `ios-targets/` (Apple), `android-watch/`,
`android-widget/`.

```
apps/mobile-template/
├── ios-targets/watch/                 # Apple Watch target sources (SwiftUI + WCSession)
│   ├── expo-target.config.js          # @bacons/apple-targets target descriptor
│   ├── WatchApp.swift                 # @main entry
│   ├── ContentView.swift              # UI
│   └── Connectivity.swift             # WCSession delegate
│   # apple-targets `root` points here: ["@bacons/apple-targets", { "root": "./ios-targets" }]
├── android-watch/                     # Wear OS Gradle module (lives OUTSIDE android/ so it survives prebuild)
│   ├── build.gradle
│   └── src/main/
│       ├── AndroidManifest.xml        # <uses-feature ...watch />
│       ├── res/values/strings.xml
│       └── java/com/pandoks/mobiletemplate/wear/
│           ├── MainActivity.kt        # Compose-for-Wear UI
│           ├── MessageStore.kt        # singleton state holder
│           └── WearMessageListener.kt # WearableListenerService
├── android-widget/                    # Android home-screen widget (classic RemoteViews + Kotlin + XML)
│   ├── kotlin/ExampleWidgetProvider.kt
│   └── res/{layout,xml}/
├── plugins/
│   ├── with-android-watch-module.js   # copies android-watch/ → android/wear, registers :wear in settings.gradle
│   └── with-hermes-vm-fix.js          # patches SDK56 dual-Hermes bundle-id collision in the Podfile
└── src/app/
    ├── (tabs)/native.tsx              # demos index
    └── demos/                         # per-capability demo screens
        ├── image-classify.tsx        # native-vision (custom Expo Module)
        ├── ble-advertise.tsx         # ble-peripheral (custom Expo Module)
        ├── face-detect.tsx
        ├── frame-processor.tsx
        ├── watch-sync.tsx
        └── ahap-haptics.tsx

packages/react-native/
├── core/                              # source-shipped shared RN components + hooks
├── watch-bridge/                      # source-shipped wrapper around watch+wear connectivity
│   └── src/hooks/use-watch-sync.ts    # the useWatchSync<TIn, TOut>() hook
├── widget-android/                    # config plugin for the Android widget (STOPGAP — see its README)
├── native-vision/                     # CUSTOM Expo Module: on-device image classification (Vision/ML Kit)
│   ├── ios/  + android/  + expo-module.config.json    # ships its own Swift + Kotlin
│   └── src/  index.ts (classifyImage) + types
└── ble-peripheral/                    # CUSTOM Expo Module: BLE peripheral advertising (CoreBluetooth / BluetoothLeAdvertiser)
    ├── ios/  + android/  + expo-module.config.json
    └── src/  index.ts + hooks/useBlePeripheral.ts
```

## When to drop to native code

Production RN apps drop to native almost entirely for **capability access not exposed to JS**, not UI. Examples:

| Need                                                     | Use existing lib                                        | Or write your own?                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Animations, gestures, custom views                       | Reanimated 4 + Expo UI                                  | Almost never                                                                                                          |
| Camera/mic session control                               | `react-native-vision-camera` v5                         | No                                                                                                                    |
| BLE, NFC                                                 | `react-native-ble-plx`, `react-native-nfc-manager`      | No                                                                                                                    |
| Home-screen widget / Live Activity (iOS)                 | `expo-widgets`                                          | No — first-party, stable SDK 56                                                                                       |
| Home-screen widget (Android)                             | custom plugin (`widget-android`)                        | Yes, for now — `expo-widgets` Android renders a stub only (SDK 56). Stopgap; see `widget-android/README.md` swap plan |
| On-device ML / image classify                            | `native-vision` (custom Expo Module)                    | Yes — no maintained lib; our reference custom module                                                                  |
| BLE peripheral / advertising                             | `ble-peripheral` (custom Expo Module)                   | Yes — `ble-plx` is central-only; advertising needs a custom module                                                    |
| Background tasks                                         | `expo-task-manager` + `expo-background-task`            | No                                                                                                                    |
| Storage (fast sync KV)                                   | `react-native-mmkv`                                     | No                                                                                                                    |
| Watch app target                                         | `@bacons/apple-targets` (iOS) + manual Gradle (Android) | Yes — write the Swift/Kotlin UI yourself, but use the libs for scaffolding                                            |
| App Intents, Share Extension, App Clip, Safari Extension | `@bacons/apple-targets`                                 | Yes — write the target body yourself                                                                                  |
| Quick Settings tile (Android)                            | None                                                    | Yes — hand-rolled, no de-facto OSS                                                                                    |
| Dynamic thermal/memory pressure                          | None mature                                             | Yes — small Expo module, or inline module (SDK 56)                                                                    |

## Adding an Apple Watch target

1. Make `apps/<app>/ios-targets/<name>/` with `expo-target.config.js`:
   ```js
   /** @type {import('@bacons/apple-targets/app.plugin').Config} */
   module.exports = {
     type: 'watch',
     name: '<app>-watch',
     displayName: '<App>',
     bundleIdentifier: 'com.<scope>.<app>.watchkitapp',
     deploymentTarget: '11.0',
     frameworks: ['WatchConnectivity', 'SwiftUI'],
     entitlements: {
       'com.apple.security.application-groups': ['group.com.<scope>.<app>']
     }
   };
   ```
2. Drop `WatchApp.swift` (`@main`), `ContentView.swift`, and any helpers (`Connectivity.swift` etc.) in the same directory.
3. Add `["@bacons/apple-targets", { "root": "./ios-targets" }]` to `app.json:plugins`.
   The `root` makes apple-targets scan `ios-targets/*/` (it globs one level — every
   sub-dir there becomes an Apple target, so keep this dir Apple-only).
4. Run `expo prebuild --clean` → the target appears in Xcode automatically.

## Adding a Wear OS app

1. Make `apps/<app>/android-watch/` with a standard Android library project:
   ```
   android-watch/
   ├── build.gradle           # apply com.android.application + kotlin-android + compose plugins
   └── src/main/
       ├── AndroidManifest.xml  # <uses-feature android:name="android.hardware.type.watch" />
       └── java/com/<scope>/<app>/wear/MainActivity.kt
   ```
2. Write a local config plugin `apps/<app>/plugins/with-android-watch-module.js` that:
   - `withSettingsGradle`: appends `include ':wear'` + `project(':wear').projectDir = ...`
   - `withDangerousMod('android')`: copies `android-watch/` → `android/wear/` so Gradle sees it
     (the on-disk source dir is platform-prefixed `android-watch/`; the Gradle module id stays `:wear`)
3. Add `"./plugins/with-android-watch-module"` to `app.json:plugins`.
4. `expo prebuild --clean` → `android/settings.gradle` now includes `:wear`, and `pnpm android` builds both APKs.

The `apps/mobile-template/plugins/with-android-watch-module.js` is the reference.

## Wiring phone ↔ watch sync

Use the bridge package — it's already there:

```tsx
import { useWatchSync } from '@pandoks.com/react-native-watch-bridge';

type In = { kind: 'pong'; ts: number };
type Out = { kind: 'ping'; text: string };

const { reachable, send, request } = useWatchSync<In, Out>({
  onMessage: (msg) => console.log('from watch:', msg)
});

send({ kind: 'ping', text: 'hello' });
// iOS only: const reply = await request({ kind: 'ping', text: 'hi' }, 2000);
```

Under the hood the bridge picks `react-native-watch-connectivity` on iOS and `react-native-wear-connectivity` on Android — same JS API, different native libs. iOS-only `request()` returns a Promise that resolves with the watch's reply; Android rejects with `UnsupportedOnPlatformError` because the Wear OS Data Layer is one-way.

## Adding an iOS widget

Use `expo-widgets`. Plugin block in `app.json`:

```json
[
  "expo-widgets",
  {
    "bundleIdentifier": "com.<scope>.<app>.widgets",
    "groupIdentifier": "group.com.<scope>.<app>",
    "widgets": [{ "name": "MyWidget", "displayName": "...", "supportedFamilies": ["systemSmall"] }]
  }
]
```

Write the widget in TypeScript using `createWidget(name, (props, ctx) => <View />)`. The `'widget'` directive marks the widget component (RSC-style).

## Adding an Android widget

> **STOPGAP — read `packages/react-native/widget-android/README.md` first.**
> `expo-widgets` Android renders a stub only (SDK 56): its Glance widget paints
> the widget's _name_, not your UI. So for a real Android widget today, use the
> custom plugin. When Expo ships the Android renderer, migrate to first-party
> `expo-widgets` (tested, small — the README has the swap plan + trigger).

Use `@pandoks.com/react-native-widget-android`:

- Sources in `apps/<app>/android-widget/{kotlin,res}/` (classic `AppWidgetProvider`
  - `RemoteViews` + XML layout).
- The plugin copies them into `android/`, rewrites the placeholder package + `R`
  import, and registers the `<receiver>` in `AndroidManifest.xml`.
- `app.json`: `["@pandoks.com/react-native-widget-android", { "name": "...", "label": "...", "minWidth": "110dp", "minHeight": "110dp" }]`
- App→widget data flows through Android `SharedPreferences` (`"widget_data"` →
  `"widgetMessage"`). Keep that write behind one small JS helper so the migration
  to `expo-widgets` only changes the native backing, not your screens.

## Adding a brand-new shared RN component (no native code)

1. Drop `<name>.tsx` in `packages/react-native/core/src/components/`.
2. Import from consumers: `@pandoks.com/react-native-core/components/<name>` (per-file exports — already wired in `core/package.json:exports`).
3. Source-shipped — no build step needed.

## Adding a brand-new cross-platform pure-TS utility

1. Drop `<name>.ts` in `packages/typescript/src/utils/`.
2. Import: `@pandoks.com/typescript/utils/<name>`.
3. Works in both mobile and web (svelte) — that's the point of the `typescript` package.

## When the lib doesn't exist (you really need a custom Expo Module)

See the SDK 56 inline-modules docs: https://docs.expo.dev/modules/inline-modules-reference/. Drop a `.swift`/`.kt` next to your JS, enable `expo.experiments.inlineModules: true`. Less boilerplate than a separate package; suitable for one-off natives.

For shared-across-apps native modules, scaffold a new `packages/react-native/<feature>/` using `create-expo-module --local` as a starting point, then migrate it to live under `packages/react-native/` instead of `apps/<app>/modules/`.
