# React Native Reserved Regions

Folds and camera cutouts as reserved regions for iPhone Duo and Android foldables, in an
[Expo module](https://docs.expo.dev/modules/module-api). For the hinge angle, use
[`expo-hinge`](https://docs.expo.dev/versions/latest/sdk/hinge/).

```tsx
<ReservedRegionsProvider style={{ flex: 1 }}>{children}</ReservedRegionsProvider>;

const regions = useReservedRegions(); // [{ kind: 'division', frame: { x, y, width, height }, active: true }]
const posture = usePosture(); // 'flat' | 'book' | 'tabletop'
```

- A `division` is a fold and an `occlusion` is a camera cutout or the Dynamic Island. Frames are in
  window coordinates, so compare them with `measureInWindow`. `useReservedRegions` returns active
  regions; pass `{ includeInactive: true }` for the rest, such as a flat Android fold.
- `usePosture` is `book` for an active vertical fold, `tabletop` for a horizontal one, and `flat`
  otherwise. On Android a fold is active while half-open; iOS has no posture API, so it reads only
  the fold's orientation.
- The provider reads the regions synchronously on its first render and whenever the window resizes,
  so layouts don't jump a frame. Its native view then reports changes only when they happen: UIKit's
  `reservedRegions(kind:)` from `updateConstraints` and `layoutSubviews` on iOS 27.1 and later, and
  Jetpack WindowManager's `FoldingFeature` plus display cutouts on Android. Earlier iOS versions
  report no regions.

Mount one provider at the app's root. Test folds on an Android foldable emulator with
`adb emu fold`, `adb emu unfold`, `adb emu sensor set hinge-angle0 90` for half-open, and
`adb emu rotate` for tabletop.
