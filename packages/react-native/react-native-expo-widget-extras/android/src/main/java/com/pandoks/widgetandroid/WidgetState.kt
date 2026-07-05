package com.pandoks.widgetandroid

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.updateAll
import androidx.glance.state.GlanceStateDefinition
import kotlinx.coroutines.flow.first
import java.io.File
import java.util.concurrent.ConcurrentHashMap

private const val STORE_NAME = "widget_state"

private val Context.widgetStateStore: DataStore<Preferences> by preferencesDataStore(
  name = STORE_NAME,
)

// Shared app↔widget store: one preferences DataStore, JSON string values keyed by widget name.
object WidgetState {
  fun keyFor(widgetName: String): Preferences.Key<String> = stringPreferencesKey(widgetName)

  suspend fun get(
    context: Context,
    widgetName: String,
  ): String? =
    context.applicationContext.widgetStateStore.data
      .first()[keyFor(widgetName)]

  suspend fun set(
    context: Context,
    widgetName: String,
    state: String,
  ) {
    update(context, widgetName) { state }
  }

  suspend fun update(
    context: Context,
    widgetName: String,
    transform: (String?) -> String,
  ): String {
    val key = keyFor(widgetName)
    val preferences =
      context.applicationContext.widgetStateStore.edit { current ->
        current[key] = transform(current[key])
      }
    updateWidget(context, widgetName)
    return preferences[key]!!
  }

  // Glance widgets live in the app process, so re-composing directly skips the system
  // BroadcastQueue round-trip (~100-500ms) that APPWIDGET_UPDATE broadcasts pay.
  private suspend fun updateWidget(
    context: Context,
    widgetName: String,
  ) {
    val appContext = context.applicationContext
    // NOTE: receiver naming contract with the config plugin — <package>.widgets.<Name>WidgetReceiver
    val updated =
      updateGlanceWidgetDirectly(
        appContext,
        "${appContext.packageName}.widgets.${widgetName}WidgetReceiver",
      )
    if (!updated) {
      updateAllWidgets(appContext)
    }
  }

  suspend fun updateAllWidgets(context: Context) {
    val appContext = context.applicationContext
    val manager = AppWidgetManager.getInstance(appContext)
    for (provider in installedProviders(manager, appContext)) {
      val ids = manager.getAppWidgetIds(provider.provider)
      if (ids.isEmpty()) continue
      if (updateGlanceWidgetDirectly(appContext, provider.provider.className)) continue
      val intent =
        Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
          .setComponent(provider.provider)
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      appContext.sendBroadcast(intent)
    }
  }

  private fun installedProviders(
    manager: AppWidgetManager,
    context: Context,
  ): List<AppWidgetProviderInfo> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.getInstalledProvidersForPackage(context.packageName, null)
    } else {
      manager.installedProviders.filter { it.provider.packageName == context.packageName }
    }

  private suspend fun updateGlanceWidgetDirectly(
    context: Context,
    receiverClassName: String,
  ): Boolean {
    // class availability is fixed at APK build, so caching lookups (hits and misses) is safe
    val receiverClass =
      receiverClasses.getOrPut(receiverClassName) {
        try {
          Class.forName(receiverClassName)
        } catch (e: ClassNotFoundException) {
          NoReceiver::class.java
        }
      }
    if (!GlanceAppWidgetReceiver::class.java.isAssignableFrom(receiverClass)) return false
    val receiver = receiverClass.getDeclaredConstructor().newInstance() as GlanceAppWidgetReceiver
    receiver.glanceAppWidget.updateAll(context)
    return true
  }

  private val receiverClasses = ConcurrentHashMap<String, Class<*>>()

  private object NoReceiver
}

// Points every widget at the shared store so app writes and widget reads see the same file.
object WidgetStateDefinition : GlanceStateDefinition<Preferences> {
  override fun getLocation(
    context: Context,
    fileKey: String,
  ): File = File(context.applicationContext.filesDir, "datastore/$STORE_NAME.preferences_pb")

  override suspend fun getDataStore(
    context: Context,
    fileKey: String,
  ): DataStore<Preferences> = context.applicationContext.widgetStateStore
}
