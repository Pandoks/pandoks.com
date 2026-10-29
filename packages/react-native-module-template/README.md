# React Native Module Template

Starting point for a native package: an [Expo module](https://docs.expo.dev/modules/module-api) in
Swift and Kotlin with a synchronous function, an async function, an event, a native view, and a
[config plugin](https://docs.expo.dev/config-plugins/introduction) that writes `Info.plist` and
`AndroidManifest.xml`. The mobile template's Device tab uses it, so every template build compiles
it.

`Function` runs synchronously over JSI; use `AsyncFunction` for anything slow. Metro compiles `src/`
directly, so there is no build step.

To start a new module:

1. Copy this directory to `packages/react-native-<name>`.
2. Replace `module-template`, `ModuleTemplate`, and `moduletemplate` with your name in file contents
   and paths. Drop `app.plugin.js` and its `exports` entry if you need no native config.
3. Add `"@pandoks.com/react-native-<name>": "workspace:*"` to the app's dependencies and the package
   to `plugins` in its `app.json`, then `pnpm install`.
4. Rebuild the app with `pnpm ios` and `pnpm android`; native code doesn't hot-reload.
