package com.pandoks.liveupdatesandroid

object LiveUpdateInteractions {
  @Volatile var listener: ((source: String, target: String) -> Unit)? = null

  fun notify(
    source: String,
    target: String,
  ) {
    listener?.invoke(source, target)
  }
}
