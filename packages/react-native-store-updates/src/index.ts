import { NativeModule, requireNativeModule } from 'expo';

export type StoreUpdate = { available: boolean; storeVersion?: string };

declare class StoreUpdatesModule extends NativeModule {
  checkForStoreUpdate(): Promise<StoreUpdate>;
  startStoreUpdate(mode: 'flexible' | 'immediate'): Promise<void>;
}

export const StoreUpdates = requireNativeModule<StoreUpdatesModule>('StoreUpdates');
