import type { EventSubscription } from 'expo-modules-core';

import WidgetAndroidModule from './WidgetAndroidModule';
import type { WidgetInteractionEvent, WidgetState } from './WidgetAndroid.types';

export type {
  WidgetAndroidEvents,
  WidgetInteractionEvent,
  WidgetState
} from './WidgetAndroid.types';

export async function setWidgetState(widgetName: string, state: WidgetState): Promise<void> {
  await WidgetAndroidModule.setWidgetState(widgetName, JSON.stringify(state));
}

export async function getWidgetState<T extends WidgetState = WidgetState>(
  widgetName: string
): Promise<T | null> {
  const state = await WidgetAndroidModule.getWidgetState(widgetName);
  return state === null ? null : (JSON.parse(state) as T);
}

export async function updateWidgets(): Promise<void> {
  await WidgetAndroidModule.updateWidgets();
}

export async function requestPinWidget(widgetName: string): Promise<boolean> {
  return WidgetAndroidModule.requestPinWidget(widgetName);
}

export function addWidgetInteractionListener(
  listener: (event: WidgetInteractionEvent) => void
): EventSubscription {
  return WidgetAndroidModule.addListener('onWidgetInteraction', listener);
}
