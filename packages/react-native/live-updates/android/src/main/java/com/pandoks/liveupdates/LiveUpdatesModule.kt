package com.pandoks.liveupdates

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.glance.appwidget.AppWidgetId
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.widgets.ExpoWidgetsAppWidgetProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private const val CHANNEL_ID = "live_updates"
private const val EXTRA_ENDS_AT = "endsAt"

class ProgressActivityState : Record {
  @Field val title: String = ""

  @Field val text: String = ""

  @Field val startedAt: Long = 0

  @Field val endsAt: Long = 0
}

// NOTE: the id in the data keeps each activity's PendingIntent distinct, since extras don't
private fun reloadWidgetsIntent(
  context: Context,
  id: String,
  endsAt: Long,
) = PendingIntent.getBroadcast(
  context,
  0,
  Intent(context, ReloadWidgetsReceiver::class.java)
    .setData(Uri.fromParts("activity", id, null))
    .putExtra(EXTRA_ENDS_AT, endsAt),
  PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
)

// NOTE: an inexact alarm, which Doze can defer
private fun scheduleWidgetsReload(
  context: Context,
  id: String,
  endsAt: Long,
) {
  context.getSystemService(AlarmManager::class.java).set(AlarmManager.RTC, endsAt, reloadWidgetsIntent(context, id, endsAt))
}

// NOTE: Android widgets have no timeline, so the app's widgets rerender when the notification times out at endsAt or is dismissed
class ReloadWidgetsReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    // NOTE: a dismissal before endsAt reloads too early, so they reload again at endsAt
    val endsAt = intent.getLongExtra(EXTRA_ENDS_AT, 0)
    if (System.currentTimeMillis() < endsAt) {
      scheduleWidgetsReload(context, requireNotNull(intent.data).schemeSpecificPart, endsAt)
    }

    // TODO: expo-widgets keeps its native reload internal, and its widgets rerender only on refresh, not on
    // ACTION_APPWIDGET_UPDATE while a Glance session is open (https://github.com/expo/peek/blob/20d8a4e5a1700d270a78f8c9baabc4a9c360b035/peek-emittables/src/main/kotlin/io/github/expo/peek/emittables/PeekEmittableAppWidget.kt#L47-L58)
    val appWidgetManager = AppWidgetManager.getInstance(context)
    val pendingResult = goAsync()
    CoroutineScope(Dispatchers.Default).launch {
      appWidgetManager.installedProviders
        .filter { provider -> provider.provider.packageName == context.packageName }
        .forEach { provider ->
          val widget =
            (Class.forName(provider.provider.className).getDeclaredConstructor().newInstance() as ExpoWidgetsAppWidgetProvider).glanceAppWidget
          appWidgetManager.getAppWidgetIds(provider.provider).forEach { appWidgetId -> widget.refresh(context, AppWidgetId(appWidgetId)) }
        }
      pendingResult.finish()
    }
  }
}

class LiveUpdatesModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("LiveUpdates")

      AsyncFunction("start") { id: String, state: ProgressActivityState ->
        val notificationManager = NotificationManagerCompat.from(context())
        notificationManager.createNotificationChannel(
          NotificationChannelCompat
            .Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_DEFAULT)
            .setName("Live updates")
            .build(),
        )
        check(
          notificationManager.areNotificationsEnabled() &&
            notificationManager.getNotificationChannelCompat(CHANNEL_ID)?.importance != NotificationManagerCompat.IMPORTANCE_NONE,
        ) { "Notifications are disabled" }
        post(context(), id, state)
      }

      AsyncFunction("update") { id: String, state: ProgressActivityState ->
        // NOTE: users can dismiss ongoing notifications on Android 14+, and Live Updates must not repost them
        if (notificationManager().activeNotifications.any { notification -> notification.tag == id && notification.id == 0 }) {
          post(context(), id, state)
        } else {
          scheduleWidgetsReload(context(), id, state.endsAt)
        }
      }

      AsyncFunction("end") { id: String ->
        notificationManager().cancel(id, 0)
      }

      AsyncFunction("active") {
        notificationManager()
          .activeNotifications
          .filter { notification -> notification.id == 0 && NotificationCompat.getChannelId(notification.notification) == CHANNEL_ID }
          .map { notification -> mapOf("id" to notification.tag, "endsAt" to notification.notification.`when`) }
      }
    }

  private fun context() = requireNotNull(appContext.reactContext).applicationContext

  private fun notificationManager() = context().getSystemService(NotificationManager::class.java)

  // NOTE: NotificationCompat.ProgressStyle is a promoted Live Update on Android 16+ and a plain progress bar before
  private fun post(
    context: Context,
    id: String,
    state: ProgressActivityState,
  ) {
    val now = System.currentTimeMillis()
    val duration = (state.endsAt - state.startedAt).toInt()
    val elapsed = (now - state.startedAt).toInt().coerceIn(0, duration)
    val openApp =
      PendingIntent.getActivity(
        context,
        0,
        context.packageManager.getLaunchIntentForPackage(context.packageName),
        PendingIntent.FLAG_IMMUTABLE,
      )
    val notification =
      NotificationCompat
        .Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.live_update_icon)
        .setContentTitle(state.title)
        .setContentText(state.text)
        .setContentIntent(openApp)
        .setDeleteIntent(reloadWidgetsIntent(context, id, state.endsAt))
        // NOTE: setTimeoutAfter needs Android 8+, so older notifications stay user-dismissible
        .setOngoing(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        .setOnlyAlertOnce(true)
        .setRequestPromotedOngoing(true)
        .setWhen(state.endsAt)
        .setUsesChronometer(true)
        .setChronometerCountDown(true)
        // NOTE: Android ignores a nonpositive timeout, so an activity past endsAt times out now
        .setTimeoutAfter((state.endsAt - now).coerceAtLeast(1))
        .setStyle(
          NotificationCompat
            .ProgressStyle()
            .setProgressSegments(listOf(NotificationCompat.ProgressStyle.Segment(duration)))
            .setProgress(elapsed),
        ).build()
    context.getSystemService(NotificationManager::class.java).notify(id, 0, notification)
  }
}
