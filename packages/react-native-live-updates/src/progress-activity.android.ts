import { requireNativeModule, uuid } from 'expo';
import { PermissionsAndroid } from 'react-native';

import type { ProgressActivity, ProgressActivityState } from './progress-activity';

const LiveUpdates = requireNativeModule<{
  start(id: string, state: ProgressActivityState): Promise<void>;
  update(id: string, state: ProgressActivityState): Promise<void>;
  end(id: string): Promise<void>;
}>('LiveUpdates');

export async function startProgressActivity(
  state: ProgressActivityState
): Promise<ProgressActivity> {
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  const id = uuid.v4();
  await LiveUpdates.start(id, state);

  return {
    update: (nextState) => LiveUpdates.update(id, nextState),
    end: () => LiveUpdates.end(id),
    addPushTokenListener: () => ({ remove() {} })
  };
}
