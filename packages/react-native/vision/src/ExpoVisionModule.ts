import { NativeModule, requireNativeModule } from 'expo';

import type { Classification } from './ExpoVision.types';

declare class ExpoVisionModule extends NativeModule<{}> {
  classifyImage(uri: string, minConfidence: number): Promise<Classification[]>;
}

/** NOTE:
 * ExpoVisionModule.swift's ModuleDefinition Name
 * ExpoVisionModule.kt's ModuleDefinition Name
 */
export default requireNativeModule<ExpoVisionModule>('ExpoVision');
