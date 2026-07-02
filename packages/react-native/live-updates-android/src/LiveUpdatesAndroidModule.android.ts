import { NativeModule, requireNativeModule } from 'expo';

import type { LiveUpdatesAndroidEvents } from './LiveUpdatesAndroid.types';

declare class LiveUpdatesAndroidModule extends NativeModule<LiveUpdatesAndroidEvents> {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  canPromote(): boolean;
  start(name: string, config: string): Promise<void>;
  update(name: string, config: string): Promise<void>;
  end(name: string): Promise<void>;
  getActive(): Promise<string[]>;
}

// NOTE: 'LiveUpdatesAndroid' must match Name() in LiveUpdatesAndroidModule.kt
export default requireNativeModule<LiveUpdatesAndroidModule>('LiveUpdatesAndroid');
