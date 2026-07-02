import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { addUserInteractionListener, type Widget } from 'expo-widgets';
import {
  addWidgetInteractionListener,
  getWidgetState,
  setWidgetState,
  type WidgetState
} from '@pandoks.com/react-native-widget-android';

export interface UseWidgetSyncOptions<T extends WidgetState> {
  name: string; // Widget name — must match the expo-widgets/widget-android plugin config
  widget: Widget<T>; // The expo-widgets handle (renders on iOS; harmless stub on Android)
  initialState: T;
}

// One-way app→widget push
export async function pushWidgetState<T extends WidgetState>(
  name: string,
  widget: Widget<T>,
  state: T
): Promise<void> {
  if (Platform.OS === 'android') {
    await setWidgetState(name, state);
    return;
  }
  widget.updateSnapshot(state);
}

async function readWidgetState<T extends WidgetState>(
  name: string,
  widget: Widget<T>
): Promise<T | null> {
  if (Platform.OS === 'android') {
    return getWidgetState<T>(name);
  }
  const entries = await widget.getTimeline();
  if (entries.length === 0) {
    return null;
  }
  const now = Date.now();
  const displayed = entries.filter((entry) => entry.date.getTime() <= now);
  const current = displayed.length > 0 ? displayed[displayed.length - 1] : entries[0];
  return current.props;
}

// Two-way live sync between app state and a home-screen widget
export function useWidgetSync<T extends WidgetState>({
  name,
  widget,
  initialState
}: UseWidgetSyncOptions<T>): [T, (next: T) => void] {
  const [state, setState] = useState<T>(initialState);
  const seedStateRef = useRef(initialState);
  // Invalidates in-flight reads so a slow stale read can't clobber a newer value or a local set
  const readSequenceRef = useRef(0);

  const refresh = useCallback(() => {
    const sequence = ++readSequenceRef.current;
    void readWidgetState(name, widget).then((current) => {
      if (readSequenceRef.current !== sequence) {
        return;
      }
      if (current === null) {
        return pushWidgetState(name, widget, seedStateRef.current);
      }
      setState((previous) =>
        JSON.stringify(previous) === JSON.stringify(current) ? previous : current
      );
    });
  }, [name, widget]);

  useEffect(() => {
    void refresh();
    const iosSubscription = addUserInteractionListener((event) => {
      if (event.source === name) {
        void refresh();
      }
    });
    const androidSubscription = addWidgetInteractionListener((event) => {
      if (event.source === name) {
        void refresh();
      }
    });

    // NOTE: Widget interactions happen while the app is backgrounded, where JS is suspended and interaction events are lost
    // Need to re-read the state when the app returns to the foreground.
    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        void refresh();
      }
    });

    return () => {
      iosSubscription.remove();
      androidSubscription.remove();
      appStateSubscription.remove();
    };
  }, [name, refresh]);

  const setWidgetSyncedState = useCallback(
    (next: T) => {
      readSequenceRef.current += 1;
      setState(next);
      void pushWidgetState(name, widget, next);
    },
    [name, widget]
  );

  return [state, setWidgetSyncedState];
}
