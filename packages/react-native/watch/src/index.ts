import { NativeModule, requireOptionalNativeModule } from 'expo';

type WatchPayload = Record<string, string | number | boolean>;

declare class WatchModule extends NativeModule<{
  onApplicationContext: (context: WatchPayload) => void;
  onReachabilityChange: (event: { isReachable: boolean }) => void;
}> {
  readonly isSupported: boolean;
  readonly isReachable: boolean;
  readonly receivedApplicationContext: WatchPayload;
  updateApplicationContext(context: WatchPayload): Promise<void>;
}

const watchModule = requireOptionalNativeModule<WatchModule>('Watch');

// NOTE: null on Android until Wear OS support and on iPads, which can't pair a watch
export const Watch = watchModule?.isSupported ? watchModule : null;
