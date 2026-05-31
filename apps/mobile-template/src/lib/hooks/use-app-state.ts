import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';

/**
 * Hook to track app state changes (active, background, inactive).
 * Useful for pausing/resuming operations when app goes to background.
 */
export function useAppState(onChange?: (state: AppStateStatus) => void) {
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      appState.current = nextAppState;
      onChange?.(nextAppState);
    });

    return () => {
      subscription.remove();
    };
  }, [onChange]);

  return appState;
}
