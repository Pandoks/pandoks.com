package com.pandoks.reservedregions

import android.app.Activity
import android.content.Context
import android.graphics.Rect
import androidx.core.view.ViewCompat
import androidx.window.WindowSdkExtensions
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

class ReservedRegionsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ReservedRegions")

    Function("getRegions") {
      val activity = appContext.throwingActivity
      // NOTE: older window extensions have no synchronous read, so the view's first event fills in
      val folds = if (WindowSdkExtensions.getInstance().extensionVersion >= 9) {
        WindowInfoTracker.getOrCreate(activity)
          .getCurrentWindowLayoutInfo(activity)
          .displayFeatures
          .filterIsInstance<FoldingFeature>()
      } else {
        emptyList()
      }
      reservedRegions(activity, folds)
    }

    View(ReservedRegionsView::class) {
      Events("onRegionsChange")
    }
  }
}

class ReservedRegionsView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onRegionsChange by EventDispatcher()
  private var folds = emptyList<FoldingFeature>()
  private var regions: List<Map<String, Any>>? = null
  private var layoutInfoJob: Job? = null

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    val activity = appContext.throwingActivity
    layoutInfoJob = appContext.mainQueue.launch {
      WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { layoutInfo ->
        folds = layoutInfo.displayFeatures.filterIsInstance<FoldingFeature>()
        emitIfChanged()
      }
    }
  }

  override fun onDetachedFromWindow() {
    layoutInfoJob?.cancel()
    super.onDetachedFromWindow()
  }

  // NOTE: skips LinearLayout's child layout, since React Native positions the children
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    emitIfChanged()
  }

  private fun emitIfChanged() {
    val current = reservedRegions(appContext.throwingActivity, folds)
    if (current != regions) {
      regions = current
      onRegionsChange(mapOf("regions" to current))
    }
  }
}

private fun reservedRegions(activity: Activity, folds: List<FoldingFeature>): List<Map<String, Any>> {
  val density = activity.resources.displayMetrics.density
  fun record(kind: String, bounds: Rect, active: Boolean) = mapOf(
    "kind" to kind,
    "frame" to mapOf(
      "x" to bounds.left / density,
      "y" to bounds.top / density,
      "width" to bounds.width() / density,
      "height" to bounds.height() / density
    ),
    "active" to active
  )
  val cutouts = ViewCompat.getRootWindowInsets(activity.window.decorView)?.displayCutout?.boundingRects.orEmpty()
  return folds.map { record("division", it.bounds, it.isSeparating) } + cutouts.map { record("occlusion", it, true) }
}
