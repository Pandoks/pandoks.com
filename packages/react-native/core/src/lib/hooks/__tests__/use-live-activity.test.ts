import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { addUserInteractionListener, type LiveActivityFactory } from 'expo-widgets';
import {
  addLiveUpdateInteractionListener,
  endLiveUpdate,
  getActiveLiveUpdates,
  requestLiveUpdatePermissions,
  startLiveUpdate,
  updateLiveUpdate
} from '@pandoks.com/react-native-live-updates-android';
import { useLiveActivity } from '../use-live-activity';

const INSTANCE_UUID = '9bef3d62-8a7a-419e-8426-feb7cb36476f';

jest.mock('expo-widgets', () => ({
  addUserInteractionListener: jest.fn().mockReturnValue({ remove: jest.fn() })
}));

jest.mock('@pandoks.com/react-native-live-updates-android', () => ({
  addLiveUpdateInteractionListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  endLiveUpdate: jest.fn().mockResolvedValue(undefined),
  getActiveLiveUpdates: jest.fn().mockResolvedValue([]),
  requestLiveUpdatePermissions: jest.fn().mockResolvedValue(true),
  startLiveUpdate: jest.fn().mockResolvedValue(undefined),
  updateLiveUpdate: jest.fn().mockResolvedValue(undefined)
}));

const mockedListener = jest.mocked(addUserInteractionListener);
const mockedLiveUpdateListener = jest.mocked(addLiveUpdateInteractionListener);
const mockedStartLiveUpdate = jest.mocked(startLiveUpdate);
const mockedUpdateLiveUpdate = jest.mocked(updateLiveUpdate);
const mockedEndLiveUpdate = jest.mocked(endLiveUpdate);
const mockedGetActive = jest.mocked(getActiveLiveUpdates);
const mockedRequestPermissions = jest.mocked(requestLiveUpdatePermissions);

const FOCUS_ANDROID = {
  config: (props: { title: string; startedAt: number }) => ({
    title: props.title,
    chronometer: { startedAt: props.startedAt },
    actions: [{ target: 'stop', label: 'End session' }]
  })
};

type FocusState = { title: string; startedAt: number };

function createActivityHandle() {
  return {
    update: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    getPushToken: jest.fn().mockResolvedValue(null),
    addPushTokenListener: jest.fn().mockReturnValue({ remove: jest.fn() })
  };
}

function createFactoryHandle(instances: unknown[] = []) {
  return {
    start: jest.fn(() => createActivityHandle()),
    getInstances: jest.fn(() => instances)
  } as unknown as LiveActivityFactory<FocusState> & {
    start: jest.Mock;
    getInstances: jest.Mock;
  };
}

function mockPlatform(os: 'ios' | 'android') {
  return jest.replaceProperty(Platform, 'OS', os);
}

describe('useLiveActivity', () => {
  let onAppStateChange: ((status: AppStateStatus) => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    onAppStateChange = undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      onAppStateChange = listener;
      return { remove: jest.fn() };
    });
  });

  it('starts an activity and reports it active', () => {
    mockPlatform('ios');
    const factory = createFactoryHandle();
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory }));
    expect(result.current.isActive).toBe(false);

    act(() => result.current.start({ title: 'Deep work', startedAt: 1 }));
    expect(factory.start).toHaveBeenCalledWith({ title: 'Deep work', startedAt: 1 }, undefined);
    expect(result.current.isActive).toBe(true);
  });

  it('adopts an already-running instance on mount', async () => {
    mockPlatform('ios');
    const existing = createActivityHandle();
    const factory = createFactoryHandle([existing]);
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory }));
    await waitFor(() => expect(result.current.isActive).toBe(true));

    act(() => result.current.update({ title: 'Deep work', startedAt: 2 }));
    expect(existing.update).toHaveBeenCalledWith({ title: 'Deep work', startedAt: 2 });
  });

  it('does not start a second activity while one is active', () => {
    mockPlatform('ios');
    const factory = createFactoryHandle();
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory }));
    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    act(() => result.current.start({ title: 'b', startedAt: 2 }));
    expect(factory.start).toHaveBeenCalledTimes(1);
  });

  it('ends the activity immediately by default and clears isActive', () => {
    mockPlatform('ios');
    const factory = createFactoryHandle();
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory }));
    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    const activity = factory.start.mock.results[0].value;

    act(() => result.current.end());
    expect(activity.end).toHaveBeenCalledWith('immediate', undefined);
    expect(result.current.isActive).toBe(false);
  });

  it('forwards interaction events with a matching source', () => {
    mockPlatform('ios');
    const factory = createFactoryHandle();
    const onInteraction = jest.fn();
    renderHook(() => useLiveActivity({ name: 'Focus', factory, onInteraction }));

    const listener = mockedListener.mock.calls[0][0];
    act(() =>
      listener({
        source: 'Focus',
        target: 'stop',
        timestamp: 1,
        type: 'ExpoWidgetsUserInteraction'
      })
    );
    expect(onInteraction).toHaveBeenCalledWith('stop');

    act(() =>
      listener({
        source: 'Counter',
        target: 'increment',
        timestamp: 2,
        type: 'ExpoWidgetsUserInteraction'
      })
    );
    expect(onInteraction).toHaveBeenCalledTimes(1);
  });

  it('forwards instance-UUID events while an activity is live (expo 56 reports ids, not names)', () => {
    mockPlatform('ios');
    const factory = createFactoryHandle();
    const onInteraction = jest.fn();
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory, onInteraction }));

    const listener = mockedListener.mock.calls[0][0];
    act(() =>
      listener({
        source: INSTANCE_UUID,
        target: 'stop',
        timestamp: 1,
        type: 'ExpoWidgetsUserInteraction'
      })
    );
    expect(onInteraction).not.toHaveBeenCalled();

    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    act(() =>
      listener({
        source: INSTANCE_UUID,
        target: 'stop',
        timestamp: 2,
        type: 'ExpoWidgetsUserInteraction'
      })
    );
    expect(onInteraction).toHaveBeenCalledWith('stop');
  });

  it('reconciles with getInstances when the app returns to the foreground', async () => {
    mockPlatform('ios');
    const factory = createFactoryHandle();
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory }));
    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    expect(result.current.isActive).toBe(true);

    // ended externally (e.g. from the lock screen) while JS was suspended
    factory.getInstances.mockReturnValue([]);
    act(() => onAppStateChange?.('active'));
    await waitFor(() => expect(result.current.isActive).toBe(false));
  });

  it('never starts on Android without an android config translator', () => {
    mockPlatform('android');
    const factory = createFactoryHandle();
    const { result } = renderHook(() => useLiveActivity({ name: 'Focus', factory }));
    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    expect(factory.start).not.toHaveBeenCalled();
    expect(mockedStartLiveUpdate).not.toHaveBeenCalled();
    expect(result.current.isActive).toBe(false);
  });

  it('starts an Android Live Update with the translated config after permission', async () => {
    mockPlatform('android');
    const factory = createFactoryHandle();
    const { result } = renderHook(() =>
      useLiveActivity({ name: 'Focus', factory, android: FOCUS_ANDROID })
    );

    act(() => result.current.start({ title: 'Deep work', startedAt: 7 }));
    expect(result.current.isActive).toBe(true);
    await waitFor(() =>
      expect(mockedStartLiveUpdate).toHaveBeenCalledWith('Focus', {
        title: 'Deep work',
        chronometer: { startedAt: 7 },
        actions: [{ target: 'stop', label: 'End session' }]
      })
    );
    expect(factory.start).not.toHaveBeenCalled();
  });

  it('rolls back isActive when notification permission is denied', async () => {
    mockPlatform('android');
    mockedRequestPermissions.mockResolvedValueOnce(false);
    const factory = createFactoryHandle();
    const { result } = renderHook(() =>
      useLiveActivity({ name: 'Focus', factory, android: FOCUS_ANDROID })
    );

    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    await waitFor(() => expect(result.current.isActive).toBe(false));
    expect(mockedStartLiveUpdate).not.toHaveBeenCalled();
  });

  it('updates and ends the Android Live Update', async () => {
    mockPlatform('android');
    const factory = createFactoryHandle();
    const { result } = renderHook(() =>
      useLiveActivity({ name: 'Focus', factory, android: FOCUS_ANDROID })
    );
    act(() => result.current.start({ title: 'a', startedAt: 1 }));
    await waitFor(() => expect(mockedStartLiveUpdate).toHaveBeenCalled());

    act(() => result.current.update({ title: 'b', startedAt: 1 }));
    await waitFor(() =>
      expect(mockedUpdateLiveUpdate).toHaveBeenCalledWith(
        'Focus',
        expect.objectContaining({ title: 'b' })
      )
    );

    act(() => result.current.end());
    await waitFor(() => expect(mockedEndLiveUpdate).toHaveBeenCalledWith('Focus'));
    expect(result.current.isActive).toBe(false);
  });

  it('forwards Android notification action taps with a matching source', () => {
    mockPlatform('android');
    const factory = createFactoryHandle();
    const onInteraction = jest.fn();
    renderHook(() =>
      useLiveActivity({ name: 'Focus', factory, android: FOCUS_ANDROID, onInteraction })
    );

    const listener = mockedLiveUpdateListener.mock.calls[0][0];
    act(() => listener({ source: 'Focus', target: 'stop', timestamp: 1 }));
    expect(onInteraction).toHaveBeenCalledWith('stop');
    act(() => listener({ source: 'Other', target: 'stop', timestamp: 2 }));
    expect(onInteraction).toHaveBeenCalledTimes(1);
  });

  it('adopts a running Android Live Update on mount', async () => {
    mockPlatform('android');
    mockedGetActive.mockResolvedValue(['Focus']);
    const factory = createFactoryHandle();
    const { result } = renderHook(() =>
      useLiveActivity({ name: 'Focus', factory, android: FOCUS_ANDROID })
    );
    await waitFor(() => expect(result.current.isActive).toBe(true));
    mockedGetActive.mockResolvedValue([]);
  });
});
