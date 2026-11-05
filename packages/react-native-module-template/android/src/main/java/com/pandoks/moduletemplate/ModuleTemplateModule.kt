package com.pandoks.moduletemplate

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
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
    textSize = 17f
  }
  private var reportedSize = Pair(-1, -1)

  init {
    addView(label)
  }

  // NOTE: Yoga can't measure native views, so report the text's size to wrap like React Native text.
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    label.measure(MeasureSpec.UNSPECIFIED, MeasureSpec.UNSPECIFIED)
    val lineWidth = label.measuredWidth
    val availableWidth = MeasureSpec.getSize(widthMeasureSpec)
    val wrapWidth = if (availableWidth > 0) minOf(availableWidth, lineWidth) else lineWidth
    label.measure(MeasureSpec.makeMeasureSpec(wrapWidth, MeasureSpec.EXACTLY), MeasureSpec.UNSPECIFIED)
    val size = Pair(lineWidth, label.measuredHeight)
    if (size != reportedSize) {
      reportedSize = size
      val density = resources.displayMetrics.density
      shadowNodeProxy.setViewSize(size.first / density.toDouble(), size.second / density.toDouble())
    }
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }
}
