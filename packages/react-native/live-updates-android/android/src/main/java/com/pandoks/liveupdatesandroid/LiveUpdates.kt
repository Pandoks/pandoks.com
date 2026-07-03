package com.pandoks.liveupdatesandroid

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

private const val CHANNEL_ID = "live_updates"
private const val TAG_PREFIX = "live-update:"

const val EXTRA_NAME = "com.pandoks.liveupdatesandroid.NAME"
const val EXTRA_TARGET = "com.pandoks.liveupdatesandroid.TARGET"

object LiveUpdates {
  fun post(
    context: Context,
    name: String,
    configJson: String,
  ) {
    ensureChannel(context)
    NotificationManagerCompat
      .from(context)
      .notify(TAG_PREFIX + name, 0, build(context, name, JSONObject(configJson)))
  }

  fun end(
    context: Context,
    name: String,
  ) {
    NotificationManagerCompat.from(context).cancel(TAG_PREFIX + name, 0)
  }

  fun getActive(context: Context): List<String> =
    context
      .getSystemService(NotificationManager::class.java)
      .activeNotifications
      .mapNotNull { it.tag }
      .filter { it.startsWith(TAG_PREFIX) }
      .map { it.removePrefix(TAG_PREFIX) }

  fun canPromote(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 36 &&
      context.getSystemService(NotificationManager::class.java).canPostPromotedNotifications()

  private fun ensureChannel(context: Context) {
    // no existence check: createNotificationChannel is a documented no-op when unchanged
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Live updates", NotificationManager.IMPORTANCE_DEFAULT),
    )
  }

  // NOTE: Small icons must be monochrome alpha-masks — the launcher icon renders as a solid blob.
  private fun smallIconResource(
    context: Context,
    config: JSONObject,
  ): Int {
    config.optString("smallIcon").takeIf { it.isNotEmpty() }?.let { icon ->
      val id = context.resources.getIdentifier(icon, "drawable", context.packageName)
      if (id != 0) return id
    }
    val appIcon =
      context.resources.getIdentifier(
        "notification_icon",
        "drawable",
        context.packageName,
      )
    if (appIcon != 0) return appIcon
    return R.drawable.live_update_icon
  }

  private fun build(
    context: Context,
    name: String,
    config: JSONObject,
  ): Notification {
    val builder =
      NotificationCompat
        .Builder(context, CHANNEL_ID)
        .setSmallIcon(smallIconResource(context, config))
        .setContentTitle(config.getString("title"))
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setRequestPromotedOngoing(true)

    config.optString("text").takeIf { it.isNotEmpty() }?.let { builder.setContentText(it) }
    config.optString("shortCriticalText").takeIf { it.isNotEmpty() }?.let {
      builder.setShortCriticalText(it)
    }

    config.optJSONObject("chronometer")?.let { chronometer ->
      builder
        .setWhen(chronometer.getLong("startedAt"))
        .setUsesChronometer(true)
        .setChronometerCountDown(chronometer.optBoolean("countDown"))
    }

    config.optJSONObject("progress")?.let { progress ->
      val style =
        NotificationCompat
          .ProgressStyle()
          .setProgressSegments(
            listOf(NotificationCompat.ProgressStyle.Segment(progress.getInt("max"))),
          ).setProgress(progress.getInt("current"))
          .setProgressIndeterminate(progress.optBoolean("indeterminate"))
      builder.setStyle(style)
    }

    config.optJSONArray("actions")?.let { actions ->
      for (index in 0 until actions.length()) {
        val action = actions.getJSONObject(index)
        val target = action.getString("target")
        // NOTE: extras don't count for Intent.filterEquals, so without it colliding (name, target) pairs
        // would overwrite each other's PendingIntent extras
        val intent =
          Intent(context, LiveUpdateActionReceiver::class.java)
            .setAction("$TAG_PREFIX$name:$target")
            .putExtra(EXTRA_NAME, name)
            .putExtra(EXTRA_TARGET, target)
        val pendingIntent =
          PendingIntent.getBroadcast(
            context,
            "$name:$target".hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          )
        builder.addAction(
          NotificationCompat.Action.Builder(0, action.getString("label"), pendingIntent).build(),
        )
      }
    }

    config.optString("deepLink").takeIf { it.isNotEmpty() }?.let { deepLink ->
      val intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).setPackage(context.packageName)
      builder.setContentIntent(
        PendingIntent.getActivity(
          context,
          name.hashCode(),
          intent,
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
      )
    }

    return builder.build()
  }
}
