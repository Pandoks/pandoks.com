package com.pandoks.imageclassifier

import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class ImageClassifierModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("ImageClassifier")

      AsyncFunction("classifyImage") { uri: String, minConfidence: Double, promise: Promise ->
        val context =
          appContext.reactContext
            ?: return@AsyncFunction promise.reject(ClassificationException("No React context"))

        val options =
          ImageLabelerOptions
            .Builder()
            .setConfidenceThreshold(minConfidence.toFloat())
            .build()
        val labeler = ImageLabeling.getClient(options)

        try {
          // ML Kit's bundled model — on-device, no network.
          val image = InputImage.fromFilePath(context, Uri.parse(uri))
          labeler
            .process(image)
            .addOnSuccessListener { labels ->
              val results =
                labels
                  .sortedByDescending { it.confidence }
                  .map { Classification(label = it.text, confidence = it.confidence.toDouble()) }
              promise.resolve(results)
            }.addOnFailureListener { e ->
              promise.reject(ClassificationException(e.message ?: "ML Kit failed"))
            }
        } catch (e: Exception) {
          promise.reject(ClassificationException(e.message ?: "Invalid image URI"))
        }
      }
    }
}

private class Classification(
  @Field val label: String = "",
  @Field val confidence: Double = 0.0,
) : Record

private class ClassificationException(
  message: String,
) : CodedException("ERR_CLASSIFICATION", message, null)
