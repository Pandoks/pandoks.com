import {
  getProgressActivities,
  startProgressActivity,
  type ProgressActivity
} from '@pandoks.com/react-native-live-updates';
import { act, userEvent } from '@testing-library/react-native';
import { renderRouter, screen } from 'expo-router/testing-library';
import { PermissionsAndroid, Platform } from 'react-native';

import FocusScreen from '../app/focus';
import FocusWidget from '../widgets/focus-widget';

jest.mock('@pandoks.com/react-native-live-updates', () => ({
  getProgressActivities: jest.fn(() => Promise.resolve([])),
  startProgressActivity: jest.fn()
}));
jest.mock('../widgets/focus-widget', () => ({
  updateSnapshot: jest.fn(),
  updateTimeline: jest.fn(),
  getTimeline: jest.fn(() => Promise.resolve([]))
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

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

test('ends a finished session with its final state so iOS keeps showing Done', async () => {
  jest.useFakeTimers();
  const finished = { ...activity, end: jest.fn(async () => {}) };
  jest.mocked(startProgressActivity).mockResolvedValueOnce(finished);
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await renderRouter({ index: FocusScreen });

  await user.press(screen.getByText('Start'));
  await act(() => jest.advanceTimersByTimeAsync(30_000));

  expect(finished.end).toHaveBeenCalledWith(expect.objectContaining({ title: 'Focus' }));
  jest.useRealTimers();
});

test('ends activities left running by an earlier launch', async () => {
  const leftover = { ...activity, end: jest.fn(async () => {}) };
  jest.mocked(getProgressActivities).mockResolvedValueOnce([leftover]);

  await renderRouter({ index: FocusScreen });

  expect(leftover.end).toHaveBeenCalled();
});

test('marks the widget stopped when ending an unfinished leftover activity', async () => {
  const widget = jest.mocked(FocusWidget);
  jest.mocked(getProgressActivities).mockResolvedValueOnce([activity]);
  widget.getTimeline.mockResolvedValueOnce([
    { date: new Date(Date.now() + 10_000), props: { title: 'Done', caption: 'At 9:00 AM' } }
  ]);

  await renderRouter({ index: FocusScreen });

  expect(widget.updateSnapshot.mock.calls).toContainEqual([
    expect.objectContaining({ title: 'Stopped' })
  ]);
});

test('keeps the widget on Done when an Android leftover activity already finished', async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  const widget = jest.mocked(FocusWidget);
  jest
    .mocked(getProgressActivities)
    .mockResolvedValueOnce([{ ...activity, endsAt: Date.now() - 10_000 }]);

  await renderRouter({ index: FocusScreen });

  expect(widget.updateSnapshot.mock.calls).toContainEqual([
    expect.objectContaining({ title: 'Done' })
  ]);
});

test('starts the session once the Android notification prompt resolves', async () => {
  jest.useFakeTimers();
  jest.replaceProperty(Platform, 'OS', 'android');
  let grant = () => {};
  jest.spyOn(PermissionsAndroid, 'request').mockReturnValueOnce(
    new Promise((resolve) => {
      grant = () => resolve(PermissionsAndroid.RESULTS.GRANTED);
    })
  );
  jest.mocked(startProgressActivity).mockResolvedValueOnce(activity);
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await renderRouter({ index: FocusScreen });

  await user.press(screen.getByText('Start'));
  await act(() => jest.advanceTimersByTimeAsync(20_000));
  const grantedAt = Date.now();
  grant();
  await act(() => jest.advanceTimersByTimeAsync(0));

  expect(startProgressActivity).toHaveBeenCalledWith(
    expect.objectContaining({ startedAt: grantedAt, endsAt: grantedAt + 30_000 })
  );
  jest.useRealTimers();
});

test('shows why a session could not start', async () => {
  jest.mocked(startProgressActivity).mockRejectedValueOnce(new Error('Notifications are disabled'));
  const user = userEvent.setup();
  await renderRouter({ index: FocusScreen });

  await user.press(screen.getByText('Start'));

  expect(screen.getByText('Notifications are disabled')).toBeTruthy();
});
