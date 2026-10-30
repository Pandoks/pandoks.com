import { requireNativeModule, uuid } from 'expo';
import { PermissionsAndroid } from 'react-native';

import type { ProgressActivity, ProgressActivityState } from './progress-activity';

const LiveUpdates = requireNativeModule<{
  start(id: string, state: ProgressActivityState): Promise<void>;
  update(id: string, state: ProgressActivityState): Promise<void>;
  end(id: string): Promise<void>;
  activeIds(): Promise<string[]>;
}>('LiveUpdates');

function toProgressActivity(id: string): ProgressActivity {
  return {
    update: (nextState) => LiveUpdates.update(id, nextState),
    end: () => LiveUpdates.end(id),
    addPushTokenListener: () => ({ remove() {} })
  };
}

export async function startProgressActivity(
  state: ProgressActivityState
): Promise<ProgressActivity> {
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const id = uuid.v4();
  await LiveUpdates.start(id, state);

  return toProgressActivity(id);
}

export async function getProgressActivities(): Promise<ProgressActivity[]> {
  return (await LiveUpdates.activeIds()).map(toProgressActivity);
}
