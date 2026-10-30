package com.pandoks.liveupdates

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

private const val CHANNEL_ID = "live_updates"

class ProgressActivityState : Record {
  @Field val title: String = ""

  @Field val text: String = ""

  @Field val startedAt: Long = 0

  @Field val endsAt: Long = 0
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
        }
      }

      AsyncFunction("end") { id: String ->
        notificationManager().cancel(id, 0)
      }

      AsyncFunction("activeIds") {
        notificationManager()
          .activeNotifications
          .filter { notification -> notification.id == 0 && NotificationCompat.getChannelId(notification.notification) == CHANNEL_ID }
          .map { notification -> notification.tag }
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
        // NOTE: setTimeoutAfter needs Android 8+, so older notifications stay user-dismissible
        .setOngoing(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        .setOnlyAlertOnce(true)
        .setRequestPromotedOngoing(true)
        .setWhen(state.endsAt)
        .setUsesChronometer(true)
        .setChronometerCountDown(true)
        .setTimeoutAfter(state.endsAt - now)
        .setStyle(
          NotificationCompat
            .ProgressStyle()
            .setProgressSegments(listOf(NotificationCompat.ProgressStyle.Segment(duration)))
            .setProgress(elapsed),
        ).build()
    context.getSystemService(NotificationManager::class.java).notify(id, 0, notification)
  }
}
