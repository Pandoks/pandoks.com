import { NativeModule, requireOptionalNativeModule } from 'expo';

type WatchPayload = Record<string, string | number | boolean>;

declare class WatchModule extends NativeModule<{
  onMessage: (message: WatchPayload) => void;
  onReachabilityChange: (event: { isReachable: boolean }) => void;
}> {
  readonly isSupported: boolean;
  readonly isReachable: boolean;
  updateApplicationContext(context: WatchPayload): void;
}

const watchModule = requireOptionalNativeModule<WatchModule>('Watch');

// NOTE: null on iPads, which can't pair a watch
export const Watch = watchModule?.isSupported ? watchModule : null;
