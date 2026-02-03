# @pandoks.com/react-native

Shared React Native components, hooks, and constants for use across mobile apps.

## Installation

This package is part of the monorepo and is available via workspace:

```json
{
  "dependencies": {
    "@pandoks.com/react-native": "workspace:*"
  }
}
```

## Usage

Import directly from the file path:

```ts
// Components
import { ThemedText } from '@pandoks.com/react-native/components/themed-text';
import { ThemedView } from '@pandoks.com/react-native/components/themed-view';
import { default as ParallaxScrollView } from '@pandoks.com/react-native/components/parallax-scroll-view';

// Hooks
import { useColorScheme } from '@pandoks.com/react-native/lib/hooks/use-color-scheme';
import { useThemeColor } from '@pandoks.com/react-native/lib/hooks/use-theme-color';

// Constants
import { Colors, Fonts } from '@pandoks.com/react-native/lib/constants/theme';
```

## Available Exports

### Components (`./components/*`)

| Component                 | Description                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| `themed-text`             | Text component that adapts to light/dark theme                               |
| `themed-view`             | View component that adapts to light/dark theme                               |
| `parallax-scroll-view`    | ScrollView with parallax header effect                                       |
| `haptic-tab`              | Tab bar button with haptic feedback                                          |
| `hello-wave`              | Animated waving hand emoji                                                   |
| `in-app-browser-link`     | Link that opens in an in-app browser                                         |
| `ui/collapsible`          | Expandable/collapsible content section                                       |
| `ui/icon-symbol`          | Cross-platform icon component (SF Symbols on iOS, Material Icons on Android) |
| `platform/platform-badge` | Badge showing current platform (iOS/Android)                                 |

### Hooks (`./lib/hooks/*`)

| Hook               | Description                           |
| ------------------ | ------------------------------------- |
| `use-color-scheme` | Get current color scheme (light/dark) |
| `use-theme-color`  | Get theme-aware colors                |

### Constants (`./lib/constants/*`)

| Export   | Description                                 |
| -------- | ------------------------------------------- |
| `Colors` | Theme color definitions for light/dark mode |
| `Fonts`  | Platform-specific font families             |

## Platform-Specific Code

This package uses `Platform.select()` for platform-specific logic instead of separate `.ios.tsx` / `.android.tsx` files.

**Why?**

Metro's `exports` field (used for explicit subpath imports) disables platform-specific file resolution. From the [Metro docs](https://metrobundler.dev/docs/configuration/#unstable_enablepackageexports-experimental):

> "If a module is matched in `"exports"`, `sourceExts` and `platforms` will not be considered (i.e. platform-specific extensions will not be used). This is done for compatibility with Node."

So instead of:

```
icon-symbol.tsx
icon-symbol.ios.tsx      # Won't be resolved!
icon-symbol.android.tsx  # Won't be resolved!
```

We use:

```tsx
// icon-symbol.tsx
import { Platform } from 'react-native';

const config = Platform.select({
  ios: {
    /* iOS config */
  },
  android: {
    /* Android config */
  },
  default: {
    /* fallback */
  }
});
```

**If you need platform-specific files**, put them in your app (not this package), where they'll work normally with Metro's resolution.

## Adding New Components

1. Create the component in `src/components/` (use `.tsx` extension)
2. Use relative imports within the package
3. For platform differences, use `Platform.select()` instead of separate files
4. The component is automatically available via `@pandoks.com/react-native/components/your-component`

## Structure

```
src/
  components/
    themed-text.tsx
    themed-view.tsx
    parallax-scroll-view.tsx
    haptic-tab.tsx
    hello-wave.tsx
    in-app-browser-link.tsx
    ui/
      collapsible.tsx
      icon-symbol.tsx
    platform/
      platform-badge.tsx
  lib/
    constants/
      theme.ts
    hooks/
      use-color-scheme.ts
      use-theme-color.ts
```
