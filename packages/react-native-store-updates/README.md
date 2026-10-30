# React Native Store Updates

App store updates for Expo apps, as an [Expo module](https://docs.expo.dev/modules/module-api).

```ts
import { StoreUpdates } from '@pandoks.com/react-native-store-updates';

const { available, storeVersion } = await StoreUpdates.checkForStoreUpdate();
if (available) await StoreUpdates.startStoreUpdate('flexible'); // or 'immediate'
```

- **Android:** Play [in-app updates](https://developer.android.com/guide/playcore/in-app-updates).
  `storeVersion` is the Play version code. A flexible update installs and restarts the app once it
  downloads. It only works in builds installed from Play, such as
  [internal app sharing](https://support.google.com/googleplay/android-developer/answer/9844679).
  `startStoreUpdate` resolves when the user cancels and rejects when the update fails.
- **iOS:** compares the installed version with the App Store's from the
  [iTunes lookup API](https://performance-partners.apple.com/search-api) for the device's region,
  skipping versions that need a newer iOS, and opens the App Store page in the app; `mode` is
  ignored.
