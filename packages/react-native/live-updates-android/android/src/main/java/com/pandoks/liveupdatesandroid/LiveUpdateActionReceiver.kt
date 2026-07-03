package com.pandoks.liveupdatesandroid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class LiveUpdateActionReceiver : BroadcastReceiver() {
  override fun onReceive(
    context: Context,
    intent: Intent,
  ) {
    val name = intent.getStringExtra(EXTRA_NAME) ?: return
    val target = intent.getStringExtra(EXTRA_TARGET) ?: return
    LiveUpdateInteractions.notify(name, target)
  }
}
