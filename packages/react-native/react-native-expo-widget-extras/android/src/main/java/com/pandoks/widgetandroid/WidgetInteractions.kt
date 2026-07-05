package com.pandoks.widgetandroid

object WidgetInteractions {
  @Volatile var listener: ((source: String, target: String) -> Unit)? = null

  fun notify(
    source: String,
    target: String,
  ) {
    listener?.invoke(source, target)
  }
}
