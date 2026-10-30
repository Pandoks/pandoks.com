package com.pandoks.moduletemplate

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.text.TextUtils
import android.view.Gravity
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.types.ColorCompat
import expo.modules.kotlin.views.ExpoView

class ModuleTemplateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ModuleTemplate")

    Events("onChange")

    Function("getGreeting") {
      val context = appContext.reactContext!!
      context.packageManager
        .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        .metaData
        ?.getString("ModuleTemplateGreeting")
    }

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent("onChange", mapOf("value" to value))
    }

    View(ModuleTemplateView::class) {
      Prop("text") { view: ModuleTemplateView, text: String ->
        view.label.text = text
      }
      Prop("color") { view: ModuleTemplateView, color: Color ->
        view.label.setTextColor(ColorCompat.toArgb(color))
      }
    }
  }
}

class ModuleTemplateView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  val label = TextView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    gravity = Gravity.END or Gravity.CENTER_VERTICAL
    textSize = 17f
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
  }

  init {
    addView(label)
  }
}
