import { requireNativeModule, uuid } from 'expo';

import type {
  ProgressActivity,
  ProgressActivityState,
  RecoveredProgressActivity
} from './progress-activity';

const LiveUpdates = requireNativeModule<{
  start(id: string, state: ProgressActivityState): Promise<void>;
  update(id: string, state: ProgressActivityState): Promise<void>;
  end(id: string): Promise<void>;
  active(): Promise<{ id: string; endsAt: number }[]>;
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
  const id = uuid.v4();
  await LiveUpdates.start(id, state);

  return toProgressActivity(id);
}

export async function getProgressActivities(): Promise<RecoveredProgressActivity[]> {
  return (await LiveUpdates.active()).map(({ id, endsAt }) => ({
    ...toProgressActivity(id),
    endsAt
  }));
}
