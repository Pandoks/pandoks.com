import {
  getProgressActivities,
  startProgressActivity,
  type ProgressActivity
} from '@pandoks.com/react-native-live-updates';
import { userEvent } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';

import FocusScreen from '../app/focus';

jest.mock('@pandoks.com/react-native-live-updates', () => ({
  getProgressActivities: jest.fn(() => Promise.resolve([])),
  startProgressActivity: jest.fn()
}));
jest.mock('../widgets/focus-widget', () => ({
  updateSnapshot: jest.fn(),
  updateTimeline: jest.fn()
}));

const activity: ProgressActivity = {
  update: async () => {},
  end: async () => {},
  addPushTokenListener: (listener) => {
    listener('activity-token');
    return { remove() {} };
  }
};

test('starts one activity when Start is tapped again before the first starts', async () => {
  jest.mocked(startProgressActivity).mockReturnValueOnce(new Promise(() => {}));
  const user = userEvent.setup();
  await renderRouter({ index: FocusScreen });

  await user.press(screen.getByText('Start'));
  await user.press(screen.getByText('Start'));

  expect(startProgressActivity).toHaveBeenCalledTimes(1);
});

test('hides the push token once the session stops', async () => {
  jest.mocked(startProgressActivity).mockResolvedValueOnce(activity);
  const user = userEvent.setup();
  await renderRouter({ index: FocusScreen });

  await user.press(screen.getByText('Start'));
  expect(screen.getByText('Push token activity-token')).toBeTruthy();
  await user.press(screen.getByText('Stop'));

  expect(screen.queryByText('Push token activity-token')).toBeNull();
});

test('ends activities left running by an earlier launch', async () => {
  const leftover = { ...activity, end: jest.fn(async () => {}) };
  jest.mocked(getProgressActivities).mockResolvedValueOnce([leftover]);

  await renderRouter({ index: FocusScreen });

  expect(leftover.end).toHaveBeenCalled();
});

test('shows why a session could not start', async () => {
  jest.mocked(startProgressActivity).mockRejectedValueOnce(new Error('Notifications are disabled'));
  const user = userEvent.setup();
  await renderRouter({ index: FocusScreen });

  await user.press(screen.getByText('Start'));

  expect(screen.getByText('Notifications are disabled')).toBeTruthy();
});
