import { NativeModule, requireNativeModule } from 'expo';

export type WatchPayload = Record<string, unknown>;

export interface WatchReceiveEvent {
  payload: WatchPayload;
}
export interface WatchReachabilityEvent {
  reachable: boolean;
}

type WatchEvents = {
  onMessage: (event: WatchReceiveEvent) => void;
  onUserInfo: (event: WatchReceiveEvent) => void;
  onContext: (event: WatchReceiveEvent) => void;
  onReachability: (event: WatchReachabilityEvent) => void;
};

declare class WatchBridgeModule extends NativeModule<WatchEvents> {
  send(payload: WatchPayload): Promise<boolean>;
  transfer(payload: WatchPayload): Promise<boolean>;
  setContext(payload: WatchPayload): Promise<boolean>;
}

// NOTE: 'WatchBridge' must match Name() in WatchBridgeModule.swift and WatchBridgeModule.kt
export default requireNativeModule<WatchBridgeModule>('WatchBridge');
