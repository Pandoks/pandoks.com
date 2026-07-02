import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { addUserInteractionListener, type Widget } from 'expo-widgets';

import {
  addWidgetInteractionListener,
  getWidgetState,
  setWidgetState
} from '@pandoks.com/react-native-widget-android';
import { pushWidgetState, useWidgetSync } from '../use-widget-sync';

jest.mock('expo-widgets', () => ({
  addUserInteractionListener: jest.fn().mockReturnValue({ remove: jest.fn() })
}));

jest.mock('@pandoks.com/react-native-widget-android', () => ({
  addWidgetInteractionListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  getWidgetState: jest.fn().mockResolvedValue(null),
  setWidgetState: jest.fn().mockResolvedValue(undefined)
}));

const mockedGetWidgetState = jest.mocked(getWidgetState);
const mockedSetWidgetState = jest.mocked(setWidgetState);
const mockedIosListener = jest.mocked(addUserInteractionListener);
const mockedAndroidListener = jest.mocked(addWidgetInteractionListener);

type CounterState = { count: number };

function createWidgetHandle() {
  return {
    updateSnapshot: jest.fn(),
    getTimeline: jest.fn().mockResolvedValue([])
  } as unknown as Widget<CounterState> & {
    updateSnapshot: jest.Mock;
    getTimeline: jest.Mock;
  };
}

function mockPlatform(os: 'ios' | 'android') {
  return jest.replaceProperty(Platform, 'OS', os);
}

describe('pushWidgetState', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pushes a snapshot through the expo-widgets handle on iOS', async () => {
    mockPlatform('ios');
    const widget = createWidgetHandle();
    await pushWidgetState('Counter', widget, { count: 2 });
    expect(widget.updateSnapshot).toHaveBeenCalledWith({ count: 2 });
    expect(mockedSetWidgetState).not.toHaveBeenCalled();
  });

  it('writes the shared store on Android', async () => {
    mockPlatform('android');
    const widget = createWidgetHandle();
    await pushWidgetState('Counter', widget, { count: 2 });
    expect(mockedSetWidgetState).toHaveBeenCalledWith('Counter', { count: 2 });
    expect(widget.updateSnapshot).not.toHaveBeenCalled();
  });
});

describe('useWidgetSync', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the widget state on mount (iOS timeline)', async () => {
    mockPlatform('ios');
    const widget = createWidgetHandle();
    widget.getTimeline.mockResolvedValue([{ date: new Date(0), props: { count: 9 } }]);
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(result.current[0]).toEqual({ count: 9 }));
  });

  it('seeds the widget with initialState when it has none', async () => {
    mockPlatform('ios');
    const widget = createWidgetHandle();
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(widget.updateSnapshot).toHaveBeenCalledWith({ count: 0 }));
    expect(result.current[0]).toEqual({ count: 0 });
  });

  it('reads the widget state on mount (Android store)', async () => {
    mockPlatform('android');
    const widget = createWidgetHandle();
    mockedGetWidgetState.mockResolvedValue({ count: 4 });
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(result.current[0]).toEqual({ count: 4 }));
  });

  it('pushes app-side updates to the widget', async () => {
    mockPlatform('android');
    const widget = createWidgetHandle();
    mockedGetWidgetState.mockResolvedValue({ count: 4 });
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(result.current[0]).toEqual({ count: 4 }));
    act(() => result.current[1]({ count: 5 }));
    expect(result.current[0]).toEqual({ count: 5 });
    expect(mockedSetWidgetState).toHaveBeenCalledWith('Counter', { count: 5 });
  });

  it('re-reads state when the widget reports an interaction with a matching source', async () => {
    mockPlatform('android');
    const widget = createWidgetHandle();
    mockedGetWidgetState.mockResolvedValue({ count: 1 });
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(result.current[0]).toEqual({ count: 1 }));

    mockedGetWidgetState.mockResolvedValue({ count: 2 });
    const onInteraction = mockedAndroidListener.mock.calls[0][0];
    act(() => onInteraction({ source: 'Counter', target: 'increment', timestamp: 1 }));
    await waitFor(() => expect(result.current[0]).toEqual({ count: 2 }));
  });

  it('ignores interactions from other widgets', async () => {
    mockPlatform('android');
    const widget = createWidgetHandle();
    mockedGetWidgetState.mockResolvedValue({ count: 1 });
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(result.current[0]).toEqual({ count: 1 }));

    mockedGetWidgetState.mockClear();
    const onInteraction = mockedAndroidListener.mock.calls[0][0];
    act(() => onInteraction({ source: 'Checklist', target: 'toggle', timestamp: 1 }));
    expect(mockedGetWidgetState).not.toHaveBeenCalled();
  });

  it('re-reads state when the app returns to the foreground', async () => {
    mockPlatform('android');
    let onAppStateChange: ((status: AppStateStatus) => void) | undefined;
    const appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        onAppStateChange = listener;
        return { remove: jest.fn() };
      });
    const widget = createWidgetHandle();
    mockedGetWidgetState.mockResolvedValue({ count: 1 });
    const { result } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await waitFor(() => expect(result.current[0]).toEqual({ count: 1 }));

    // widget tap happened while backgrounded: store changed, no event was received
    mockedGetWidgetState.mockResolvedValue({ count: 6 });
    act(() => onAppStateChange?.('active'));
    await waitFor(() => expect(result.current[0]).toEqual({ count: 6 }));
    appStateSpy.mockRestore();
  });

  it('removes all subscriptions on unmount', async () => {
    mockPlatform('ios');
    const removeIos = jest.fn();
    const removeAndroid = jest.fn();
    const removeAppState = jest.fn();
    mockedIosListener.mockReturnValue({ remove: removeIos });
    mockedAndroidListener.mockReturnValue({ remove: removeAndroid });
    const appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: removeAppState });
    const widget = createWidgetHandle();
    const { unmount } = renderHook(() =>
      useWidgetSync({ name: 'Counter', widget, initialState: { count: 0 } })
    );
    await act(async () => {});
    unmount();
    expect(removeIos).toHaveBeenCalled();
    expect(removeAndroid).toHaveBeenCalled();
    expect(removeAppState).toHaveBeenCalled();
    appStateSpy.mockRestore();
  });
});
