# mobile-template

Native-only (iOS + Android) [Expo](https://expo.dev) app, started from [`create-expo-app`](https://www.npmjs.com/package/create-expo-app) with web support stripped. Shared UI lives in `@pandoks.com/react-native-core` (`packages/react-native/core`).

## Get started

1. Install dependencies (from the repo root)

   ```bash
   pnpm install
   ```

2. Start the app

   ```bash
   pnpm start        # Metro / Expo Go
   pnpm ios          # native build → simulator/device
   pnpm android      # native build → emulator/device
   ```

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Learn more

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Expo Router](https://docs.expo.dev/router/introduction/): File-based routing for React Native.
