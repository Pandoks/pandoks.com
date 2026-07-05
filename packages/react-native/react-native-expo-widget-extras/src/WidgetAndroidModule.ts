import type { EventSubscription } from 'expo-modules-core';

import type { WidgetAndroidEvents } from './WidgetAndroid.types';

const noopSubscription: EventSubscription = { remove() {} };

// NOTE: Metro resolves WidgetAndroidModule.android.ts on Android; every other platform no-op stub.
export default {
  setWidgetState(_widgetName: string, _state: string): Promise<void> {
    return Promise.resolve();
  },
  getWidgetState(_widgetName: string): Promise<string | null> {
    return Promise.resolve(null);
  },
  updateWidgets(): Promise<void> {
    return Promise.resolve();
  },
  requestPinWidget(_widgetName: string): Promise<boolean> {
    return Promise.resolve(false);
  },
  addListener<EventName extends keyof WidgetAndroidEvents>(
    _eventName: EventName,
    _listener: WidgetAndroidEvents[EventName]
  ): EventSubscription {
    return noopSubscription;
  }
};
