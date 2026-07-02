import type { EventSubscription } from 'expo-modules-core';

import type { LiveUpdatesAndroidEvents } from './LiveUpdatesAndroid.types';

const noopSubscription: EventSubscription = { remove() {} };

// NOTE: Metro resolves LiveUpdatesAndroidModule.android.ts on Android; every other platform no-op stub.
export default {
  requestPermissionsAsync(): Promise<{ granted: boolean }> {
    return Promise.resolve({ granted: false });
  },
  canPromote(): boolean {
    return false;
  },
  start(_name: string, _config: string): Promise<void> {
    return Promise.resolve();
  },
  update(_name: string, _config: string): Promise<void> {
    return Promise.resolve();
  },
  end(_name: string): Promise<void> {
    return Promise.resolve();
  },
  getActive(): Promise<string[]> {
    return Promise.resolve([]);
  },
  addListener<EventName extends keyof LiveUpdatesAndroidEvents>(
    _eventName: EventName,
    _listener: LiveUpdatesAndroidEvents[EventName]
  ): EventSubscription {
    return noopSubscription;
  }
};
