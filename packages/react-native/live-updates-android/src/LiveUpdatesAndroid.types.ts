export interface LiveUpdateAction<TTarget extends string = string> {
  target: TTarget;
  label: string;
}

export interface LiveUpdateConfig<TTarget extends string = string> {
  title: string;
  text?: string;
  shortCriticalText?: string; // Status-bar chip text while promoted (Android 16)
  smallIcon?: string; // @drawable/live_update_icon
  chronometer?: { startedAt: number; countDown?: boolean };
  progress?: { max: number; current: number; indeterminate?: boolean };
  actions?: LiveUpdateAction<TTarget>[];
  deepLink?: string; // Opened when the notification body is tapped (app deep link)
}

export interface LiveUpdateInteractionEvent<TTarget extends string = string> {
  source: string; // Live update name that triggered the interaction
  target: TTarget; // Action `target` that was tapped
  timestamp: number; // epoch ms
}

export type LiveUpdatesAndroidEvents = {
  onLiveUpdateInteraction: (event: LiveUpdateInteractionEvent) => void;
};
