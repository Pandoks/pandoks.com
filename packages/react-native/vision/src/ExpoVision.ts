import ExpoVisionModule from './ExpoVisionModule';
import type { Classification, ClassifyOptions } from './ExpoVision.types';

export type { Classification, ClassifyOptions };

/**
 * Classify the contents of an image, fully on-device (no network).
 *
 * iOS uses Vision's built-in classifier (`VNClassifyImageRequest`);
 * Android uses ML Kit's bundled image-labeling model. Both ship the model
 * with the app, so the first call works offline.
 *
 * @param uri  A `file://` URI (or absolute path) to the image.
 * @returns    Labels sorted by confidence, descending.
 */
export async function classifyImage({
  uri,
  options = { minConfidence: 0.5 }
}: {
  uri: string;
  options?: ClassifyOptions;
}): Promise<Classification[]> {
  return ExpoVisionModule.classifyImage(uri, options.minConfidence);
}
