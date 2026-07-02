import type { EventSubscription } from 'expo-modules-core';

import LiveUpdatesAndroidModule from './LiveUpdatesAndroidModule';
import type { LiveUpdateConfig, LiveUpdateInteractionEvent } from './LiveUpdatesAndroid.types';

export type {
  LiveUpdateAction,
  LiveUpdateConfig,
  LiveUpdateInteractionEvent,
  LiveUpdatesAndroidEvents
} from './LiveUpdatesAndroid.types';

export async function startLiveUpdate(name: string, config: LiveUpdateConfig): Promise<void> {
  await LiveUpdatesAndroidModule.start(name, JSON.stringify(config));
}

export async function updateLiveUpdate(name: string, config: LiveUpdateConfig): Promise<void> {
  await LiveUpdatesAndroidModule.update(name, JSON.stringify(config));
}

export async function endLiveUpdate(name: string): Promise<void> {
  await LiveUpdatesAndroidModule.end(name);
}

export async function getActiveLiveUpdates(): Promise<string[]> {
  return LiveUpdatesAndroidModule.getActive();
}

export function canPromoteLiveUpdates(): boolean {
  return LiveUpdatesAndroidModule.canPromote();
}

export async function requestLiveUpdatePermissions(): Promise<boolean> {
  const response = await LiveUpdatesAndroidModule.requestPermissionsAsync();
  return response.granted;
}

export function addLiveUpdateInteractionListener(
  listener: (event: LiveUpdateInteractionEvent) => void
): EventSubscription {
  return LiveUpdatesAndroidModule.addListener('onLiveUpdateInteraction', listener);
}
