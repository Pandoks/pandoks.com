import { NativeModule, requireNativeModule } from 'expo';

declare class ExpoVisionModule extends NativeModule<{}> {
  setValueAsync(value: string): Promise<void>;
}

export default requireNativeModule<ExpoVisionModule>('ExpoVision');
