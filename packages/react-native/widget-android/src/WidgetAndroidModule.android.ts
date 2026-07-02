import { NativeModule, requireNativeModule } from 'expo';

import type { WidgetAndroidEvents } from './WidgetAndroid.types';

declare class WidgetAndroidModule extends NativeModule<WidgetAndroidEvents> {
  setWidgetState(widgetName: string, state: string): Promise<void>;
  getWidgetState(widgetName: string): Promise<string | null>;
  updateWidgets(): Promise<void>;
  requestPinWidget(widgetName: string): Promise<boolean>;
}

// NOTE: 'WidgetAndroid' must match Name() in WidgetAndroidModule.kt
export default requireNativeModule<WidgetAndroidModule>('WidgetAndroid');
