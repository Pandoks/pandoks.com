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
import { createLiveActivity } from 'expo-widgets';

export type ProgressActivityState = {
  title: string;
  text: string;
  /** Epoch ms. iOS fills the progress bar from `startedAt` to `endsAt` without updates. */
  startedAt: number;
  endsAt: number;
};

export type ProgressActivity = {
  update(state: ProgressActivityState): Promise<void>;
  end(): Promise<void>;
  /** iOS: the ActivityKit token for `liveactivity` pushes; Android Live Updates have none. */
  addPushTokenListener(listener: (pushToken: string) => void): EventSubscription;
};

const ProgressLiveActivity = createLiveActivity<ProgressActivityState>(
  'ProgressActivity',
  (state, environment) => {
    'widget';
    const accentColor = '#FF9F0A';
    const timerInterval = { lower: new Date(state.startedAt), upper: new Date(state.endsAt) };
    const countdown = (size: number, width: number) => (
      <Text
        timerInterval={environment.isStale ? undefined : timerInterval}
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

export function startProgressActivity(state: ProgressActivityState): Promise<ProgressActivity> {
  const liveActivity = ProgressLiveActivity.start(state, undefined, new Date(state.endsAt));

  return Promise.resolve({
    update: (nextState) => liveActivity.update(nextState, new Date(nextState.endsAt)),
    end: () => liveActivity.end('immediate'),
    addPushTokenListener: (listener) =>
      liveActivity.addPushTokenListener(({ pushToken }) => listener(pushToken))
  });
}
