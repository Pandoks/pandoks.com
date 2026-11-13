import { HStack, Image, ProgressView, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  frame,
  labelsHidden,
  monospacedDigit,
  multilineTextAlignment,
  padding,
  progressViewStyle,
  tint
} from '@expo/ui/swift-ui/modifiers';
import { type EventSubscription } from 'expo';
import { createLiveActivity, type LiveActivity } from 'expo-widgets';

export type ProgressActivityState = {
  title: string;
  text: string;
  /** Epoch ms. iOS fills the progress bar from `startedAt` to `endsAt` without updates. */
  startedAt: number;
  endsAt: number;
};

export type ProgressActivity = {
  update(state: ProgressActivityState): Promise<void>;
  /**
   * Without `finalState` the activity disappears now. iOS keeps showing `finalState` (Done once
   * `endsAt` passed) until the system dismisses it; Android removes the notification either way.
   */
  end(finalState?: ProgressActivityState): Promise<void>;
  /**
   * iOS: the ActivityKit token for `liveactivity` pushes, `null` until issued; Android Live Updates
   * have none. Read it, then listen for changes, since a token issued earlier isn't replayed.
   */
  getPushToken(): Promise<string | null>;
  addPushTokenListener(listener: (pushToken: string) => void): EventSubscription;
};

export type RecoveredProgressActivity = ProgressActivity & {
  /** Android only, since iOS can't read a running activity's state. */
  endsAt?: number;
};

const ProgressLiveActivity = createLiveActivity<ProgressActivityState>(
  'ProgressActivity',
  (state, environment) => {
    'widget';
    const accentColor = '#FF9F0A';
    const timerInterval = { lower: new Date(state.startedAt), upper: new Date(state.endsAt) };
    const isDone = environment.isStale || Date.now() >= state.endsAt;
    const countdown = (size: number, width: number) => (
      <Text
        timerInterval={isDone ? undefined : timerInterval}
        modifiers={[
          font({ size, weight: 'semibold' }),
          monospacedDigit(),
          foregroundStyle(accentColor),
          multilineTextAlignment('trailing'),
          frame({ width, alignment: 'trailing' })
        ]}
      >
        Done
      </Text>
    );
    const progress = (
      <ProgressView
        timerInterval={timerInterval}
        countsDown={false}
        modifiers={[progressViewStyle('linear'), tint(accentColor), labelsHidden()]}
      />
    );
    const icon = <Image systemName="timer" color={accentColor} />;

    return {
      banner: (
        <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 16 })]}>
          <HStack>
            <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{state.title}</Text>
            <Spacer />
            {countdown(17, 64)}
          </HStack>
          <Text
            modifiers={[
              font({ size: 15 }),
              foregroundStyle({ type: 'hierarchical', style: 'secondary' })
            ]}
          >
            {state.text}
          </Text>
          {progress}
        </VStack>
      ),
      compactLeading: icon,
      compactTrailing: countdown(15, 44),
      minimal: icon,
      expandedLeading: (
        <HStack spacing={6} modifiers={[padding({ leading: 8 })]}>
          {icon}
          <Text modifiers={[font({ size: 17, weight: 'semibold' })]}>{state.title}</Text>
        </HStack>
      ),
      expandedTrailing: countdown(17, 64),
      expandedBottom: (
        <VStack alignment="leading" spacing={8} modifiers={[padding({ horizontal: 8 })]}>
          <Text
            modifiers={[
              font({ size: 15 }),
              foregroundStyle({ type: 'hierarchical', style: 'secondary' })
            ]}
          >
            {state.text}
          </Text>
          {progress}
        </VStack>
      )
    };
  }
);

function toProgressActivity(liveActivity: LiveActivity<ProgressActivityState>): ProgressActivity {
  return {
    update: (nextState) => liveActivity.update(nextState, new Date(nextState.endsAt)),
    end: (finalState) =>
      finalState ? liveActivity.end('default', finalState) : liveActivity.end('immediate'),
    getPushToken: () => liveActivity.getPushToken(),
    addPushTokenListener: (listener) =>
      liveActivity.addPushTokenListener(({ pushToken }) => listener(pushToken))
  };
}

export function startProgressActivity(state: ProgressActivityState): Promise<ProgressActivity> {
  return new Promise((resolve) => {
    resolve(
      toProgressActivity(ProgressLiveActivity.start(state, undefined, new Date(state.endsAt)))
    );
  });
}

/** Running activities, including ones that outlived an earlier app process. */
export function getProgressActivities(): Promise<RecoveredProgressActivity[]> {
  return Promise.resolve(ProgressLiveActivity.getInstances().map(toProgressActivity));
}
