package com.pandoks.liveupdatesandroid

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.core.os.bundleOf
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LiveUpdatesAndroidModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("LiveUpdatesAndroid")

      Events("onLiveUpdateInteraction")

      OnStartObserving {
        LiveUpdateInteractions.listener = { source, target ->
          sendEvent(
            "onLiveUpdateInteraction",
            bundleOf(
              "source" to source,
              "target" to target,
              "timestamp" to System.currentTimeMillis(),
            ),
          )
        }
      }

      OnStopObserving {
        LiveUpdateInteractions.listener = null
      }

      AsyncFunction("requestPermissionsAsync") { promise: Promise ->
        if (Build.VERSION.SDK_INT < 33) {
          return@AsyncFunction promise.resolve(bundleOf("status" to "granted", "granted" to true))
        }
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.POST_NOTIFICATIONS,
        )
      }

      Function("canPromote") {
        LiveUpdates.canPromote(requireContext())
      }

      AsyncFunction("start") { name: String, config: String ->
        LiveUpdates.post(requireContext(), name, config)
      }

      AsyncFunction("update") { name: String, config: String ->
        LiveUpdates.post(requireContext(), name, config)
      }

      AsyncFunction("end") { name: String ->
        LiveUpdates.end(requireContext(), name)
      }

      AsyncFunction("getActive") {
        LiveUpdates.getActive(requireContext())
      }
    }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw LiveUpdatesException("No React context")
}

private class LiveUpdatesException(
  message: String,
) : CodedException("ERR_LIVE_UPDATES", message, null)
