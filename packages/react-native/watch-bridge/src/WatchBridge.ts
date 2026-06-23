import WatchModule, { type WatchPayload } from './WatchBridgeModule';

export type { WatchPayload, WatchReceiveEvent } from './WatchBridgeModule';
export { useWatchSync } from './hooks/useWatchSync';
export type { UseWatchSyncOptions, UseWatchSyncResult } from './hooks/useWatchSync';

export function send(payload: WatchPayload): Promise<boolean> {
  return WatchModule.send(payload);
}

export function transfer(payload: WatchPayload): Promise<boolean> {
  return WatchModule.transfer(payload);
}

export function setContext(payload: WatchPayload): Promise<boolean> {
  return WatchModule.setContext(payload);
}
