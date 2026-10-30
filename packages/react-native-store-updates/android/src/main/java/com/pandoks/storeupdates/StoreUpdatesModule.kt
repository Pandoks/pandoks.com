package com.pandoks.storeupdates

import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class StoreUpdatesModule : Module() {
  private val appUpdateManager by lazy { AppUpdateManagerFactory.create(appContext.reactContext!!) }

  // NOTE: completing a flexible update installs it and restarts the app
  private val installListener = InstallStateUpdatedListener { installState ->
    if (installState.installStatus() == InstallStatus.DOWNLOADED) appUpdateManager.completeUpdate()
  }

  override fun definition() = ModuleDefinition {
    Name("StoreUpdates")

    OnCreate { appUpdateManager.registerListener(installListener) }

    OnDestroy { appUpdateManager.unregisterListener(installListener) }

    AsyncFunction("checkForStoreUpdate") { promise: Promise ->
      appUpdateManager.appUpdateInfo
        .addOnSuccessListener { appUpdateInfo ->
          if (appUpdateInfo.installStatus() == InstallStatus.DOWNLOADED) appUpdateManager.completeUpdate()
          if (appUpdateInfo.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE) {
            promise.resolve(
              mapOf("available" to true, "storeVersion" to appUpdateInfo.availableVersionCode().toString())
            )
          } else {
            promise.resolve(mapOf("available" to false))
          }
        }
        .addOnFailureListener { exception -> promise.reject(CodedException(exception)) }
    }

    AsyncFunction("startStoreUpdate") { mode: String, promise: Promise ->
      val updateType = if (mode == "immediate") AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
      appUpdateManager.appUpdateInfo
        .onSuccessTask { appUpdateInfo ->
          appUpdateManager.startUpdateFlow(
            appUpdateInfo,
            appContext.throwingActivity,
            AppUpdateOptions.defaultOptions(updateType)
          )
        }
        .addOnSuccessListener { promise.resolve() }
        .addOnFailureListener { exception -> promise.reject(CodedException(exception)) }
    }
  }
}
