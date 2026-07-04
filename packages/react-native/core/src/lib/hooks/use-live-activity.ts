import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import {
  addUserInteractionListener,
  type LiveActivity,
  type LiveActivityDismissalPolicy,
  type LiveActivityFactory
} from 'expo-widgets';

import {
  addLiveUpdateInteractionListener,
  endLiveUpdate,
  getActiveLiveUpdates,
  requestLiveUpdatePermissions,
  startLiveUpdate,
  updateLiveUpdate,
  type LiveUpdateConfig
} from '@pandoks.com/react-native-live-updates-android';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UseLiveActivityOptions<
  T extends Record<string, unknown>,
  TTarget extends string = string
> {
  name: string; // Live Activity name — must match createLiveActivity's name (interaction events' `source`)
  factory: LiveActivityFactory<T>;
  android?: { config: (props: T) => LiveUpdateConfig<TTarget> }; // Omit to make the hook iOS-only
  onInteraction?: (target: TTarget) => void; // Called when a button inside the activity/notification is tapped while the app's JS is alive
}

/** Manages a single live session UI across platforms. iOS: ActivityKit Live Activity. Android: Android 16 Live Update notification. */
export function useLiveActivity<
  T extends Record<string, unknown>,
  TTarget extends string = string
>({
  name,
  factory,
  android,
  onInteraction
}: UseLiveActivityOptions<T, TTarget>): {
  isActive: boolean;
  start: (props: T, url?: string) => void;
  update: (props: T) => void;
  end: (props?: T, dismissalPolicy?: LiveActivityDismissalPolicy) => void;
} {
  const [activity, setActivity] = useState<LiveActivity<T> | null>(null);
  const [androidActive, setAndroidActive] = useState(false);
  const onInteractionRef = useRef(onInteraction);
  const androidConfigRef = useRef(android?.config);

  const activityRef = useRef(activity);

  useEffect(() => {
    onInteractionRef.current = onInteraction;
    androidConfigRef.current = android?.config;
    activityRef.current = activity;
  });

  const androidSequence = useRef(0);
  const androidOps = useRef<Promise<unknown>>(Promise.resolve());

  const enqueueAndroidOp = useCallback((operation: () => Promise<unknown>) => {
    androidOps.current = androidOps.current.then(operation, operation);
  }, []);

  const reconcile = useCallback(() => {
    if (Platform.OS === 'ios') {
      void Promise.resolve().then(() => {
        setActivity(factory.getInstances()[0] ?? null);
      });
      return;
    }
    const sequence = ++androidSequence.current;
    void getActiveLiveUpdates().then((active) => {
      if (androidSequence.current === sequence) {
        setAndroidActive(active.includes(name));
      }
    });
  }, [factory, name]);

  useEffect(() => {
    reconcile();
    const appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') {
        reconcile();
      }
    });
    return () => appStateSubscription.remove();
  }, [reconcile]);

  useEffect(() => {
    const iosSubscription = addUserInteractionListener((event) => {
      // NOTE: Live Activity buttons report the activity instance's UUID as `source` (not the
      // createLiveActivity name), and expo-widgets 56 doesn't expose that id to JS — so accept
      // UUID-shaped sources whenever our activity is live. Only ambiguous if an app runs several
      // activity types concurrently. The `=== name` arm future-proofs an upstream fix.
      const matchesInstance = activityRef.current !== null && UUID_PATTERN.test(event.source);
      if (event.source === name || matchesInstance) {
        onInteractionRef.current?.(event.target as TTarget);
      }
    });
    const androidSubscription = addLiveUpdateInteractionListener((event) => {
      if (event.source === name) {
        onInteractionRef.current?.(event.target as TTarget);
      }
    });
    return () => {
      iosSubscription.remove();
      androidSubscription.remove();
    };
  }, [name]);

  const start = useCallback(
    (props: T, url?: string) => {
      if (Platform.OS === 'ios') {
        if (activity !== null) {
          return;
        }
        setActivity(factory.start(props, url));
        return;
      }
      const toConfig = androidConfigRef.current;
      if (toConfig === undefined || androidActive) {
        return;
      }
      androidSequence.current += 1;
      setAndroidActive(true);
      enqueueAndroidOp(() =>
        requestLiveUpdatePermissions().then((granted) => {
          if (!granted) {
            androidSequence.current += 1;
            setAndroidActive(false);
            return;
          }
          return startLiveUpdate(name, toConfig(props));
        })
      );
    },
    [activity, androidActive, enqueueAndroidOp, factory, name]
  );

  const update = useCallback(
    (props: T) => {
      if (Platform.OS === 'ios') {
        void activity?.update(props);
        return;
      }
      const toConfig = androidConfigRef.current;
      if (toConfig === undefined || !androidActive) {
        return;
      }
      enqueueAndroidOp(() => updateLiveUpdate(name, toConfig(props)));
    },
    [activity, androidActive, enqueueAndroidOp, name]
  );

  const end = useCallback(
    (props?: T, dismissalPolicy: LiveActivityDismissalPolicy = 'immediate') => {
      if (Platform.OS === 'ios') {
        if (activity === null) {
          return;
        }
        void activity.end(dismissalPolicy, props);
        // also end every other instance of this type: expired (12h+) activities linger in
        // getInstances and the next reconcile would re-adopt one, resurrecting the session
        for (const instance of factory.getInstances()) {
          void instance.end(dismissalPolicy, props);
        }
        setActivity(null);
        return;
      }
      if (!androidActive) {
        return;
      }
      androidSequence.current += 1;
      enqueueAndroidOp(() => endLiveUpdate(name));
      setAndroidActive(false);
    },
    [activity, androidActive, enqueueAndroidOp, factory, name]
  );

  return {
    isActive: Platform.OS === 'ios' ? activity !== null : androidActive,
    start,
    update,
    end
  };
}
