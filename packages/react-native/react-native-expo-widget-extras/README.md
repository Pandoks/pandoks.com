# @pandoks.com/react-native-widget-android

> **STOPGAP.** `expo-widgets` (SDK 56) renders a stub on Android — its
> Glance widget paints the widget's _name_, not your UI
> (`expo-widgets/android/.../ExpoWidgetsGlanceWidget.kt`), and its Android
> generation is off by default (`enableAndroid ?? false`). This package is
> the real Android widget path until Expo ships the Android renderer.
> See the swap plan at the bottom.

Android home-screen widgets for Expo apps: Glance (Jetpack Compose for
widgets) UI, a shared app↔widget state store, interaction events back to
JS, and a config plugin that wires app-owned widget sources into the
prebuild-generated `android/` project.

## How it fits together

- **Widget UI** is app-owned Kotlin in `apps/<app>/android-widget/kotlin/`
  (Glance `@Composable` code — outside `android/` so it survives
  `expo prebuild --clean`). Files use the `com.example` placeholder
  package; the plugin rewrites it to the app's package.
- **State** is one Preferences DataStore file (`widget_state`), JSON
  string per widget name. JS writes it via `setWidgetState`; widgets read
  it via `WidgetStateDefinition` + `currentState<Preferences>()`; every
  write re-composes that widget directly in-process (Glance runs in the
  app process — no `APPWIDGET_UPDATE` broadcast round-trip; the broadcast
  stays as a fallback for receivers the naming contract can't resolve).
- **Interactions** run in the app process (Glance `ActionCallback`), so a
  widget button can mutate the same store and hand `{source, target}` to
  the module's event emitter — live in JS via
  `addWidgetInteractionListener` when the app is running, persisted state
  otherwise.

## Usage

`app.json`:

```json
[
  "@pandoks.com/react-native-widget-android",
  {
    "widgets": [
      {
        "name": "Counter",
        "displayName": "Counter",
        "description": "Increment from your home screen",
        "targetCellWidth": 3,
        "targetCellHeight": 2
      }
    ]
  }
]
```

Per-widget options: `minWidth`/`minHeight` (dp, default 180/110),
`targetCellWidth`/`targetCellHeight` (launcher grid cells, default 3/2),
`resizeMode` (`none|horizontal|vertical|both`, default
`horizontal|vertical`).

Naming contract: a widget named `Counter` must have a
`class CounterWidgetReceiver : GlanceAppWidgetReceiver()` in
`android-widget/kotlin/` (package `com.example.widgets`). The plugin
registers `<package>.widgets.CounterWidgetReceiver` in the manifest, and
`requestPinWidget('Counter')` resolves the same class. This assumes
`applicationId` == `namespace` (true for Expo-generated projects).

JS API (no-ops on non-Android platforms):

```ts
import {
  addWidgetInteractionListener,
  getWidgetState,
  requestPinWidget,
  setWidgetState
} from '@pandoks.com/react-native-widget-android';

await setWidgetState('Counter', { count: 3 }); // persists + refreshes widgets
const state = await getWidgetState<{ count: number }>('Counter');
const subscription = addWidgetInteractionListener(({ source, target }) => {});
await requestPinWidget('Counter'); // launcher pin dialog (great on emulators)
```

Widget-side Kotlin gets the same store:

```kotlin
val state = currentState<Preferences>()[WidgetState.keyFor("Counter")] // JSON string
WidgetState.update(context, "Counter") { current -> /* return new JSON */ }
WidgetInteractions.notify("Counter", "increment")
```

## Swap plan → first-party `expo-widgets`

**Trigger:** an Expo SDK release where `expo-widgets` renders real UI on
Android — watch `ExpoWidgetsGlanceWidget.kt` (still `Text(widgetName)` in
every published release through 57.0.1) and the package CHANGELOG. As of
2026-07 the real implementation is actively landing on expo `main`
(widget JS bundle + Hermes runtime + Glance rendering + interactions,
opt-in via `enableAndroid`) — expect it around SDK 58. When it ships:

1. Move each widget's UI from `android-widget/kotlin/` into the app's
   TypeScript widget files (`createWidget` + the `'widget'` directive),
   adding `android` size config to the `expo-widgets` plugin block and
   `enableAndroid: true`.
2. Replace `setWidgetState(name, state)` calls with
   `MyWidget.updateSnapshot(state)` and
   `addWidgetInteractionListener` with `expo-widgets`'
   `addUserInteractionListener` (same `{source, target}` event shape —
   deliberate).
3. Delete the `@pandoks.com/react-native-widget-android` plugin block,
   the dependency, and `android-widget/`.

The JS surface was kept one-small-helper-sized so this swap only touches
the widget definitions, not the screens.
