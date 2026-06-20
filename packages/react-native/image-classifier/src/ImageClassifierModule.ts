import { NativeModule, requireNativeModule } from 'expo';

import type { Classification } from './ImageClassifier.types';

declare class ImageClassifierModule extends NativeModule {
  classifyImage(uri: string, minConfidence: number): Promise<Classification[]>;
}

/** NOTE:
 * ImageClassifierModule.swift's ModuleDefinition Name
 * ImageClassifierModule.kt's ModuleDefinition Name
 */
export default requireNativeModule<ImageClassifierModule>('ImageClassifier');
