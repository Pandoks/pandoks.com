package com.pandoks.widgetandroid

import android.content.Context
import androidx.core.os.bundleOf
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WidgetAndroidModule : Module() {
  override fun definition() =
    ModuleDefinition {
      Name("WidgetAndroid")

      Events("onWidgetInteraction")

      OnStartObserving {
        WidgetInteractions.listener = { source, target ->
          sendEvent(
            "onWidgetInteraction",
            bundleOf(
              "source" to source,
              "target" to target,
              "timestamp" to System.currentTimeMillis(),
            ),
          )
        }
      }

      OnStopObserving {
        WidgetInteractions.listener = null
      }

      AsyncFunction("setWidgetState") Coroutine { widgetName: String, state: String ->
        WidgetState.set(requireContext(), widgetName, state)
      }

      AsyncFunction("getWidgetState") Coroutine { widgetName: String ->
        WidgetState.get(requireContext(), widgetName)
      }

      // NOTE: the empty `->` disambiguates expo's zero-arg Coroutine overload from the one-arg one
      @Suppress("ktlint:standard:function-literal")
      AsyncFunction("updateWidgets") Coroutine { ->
        WidgetState.updateAllWidgets(requireContext())
      }

      AsyncFunction("requestPinWidget") Coroutine { widgetName: String ->
        val context = requireContext()
        // NOTE: receiver naming contract with the config plugin — <package>.widgets.<Name>WidgetReceiver
        val receiverName = "${context.packageName}.widgets.${widgetName}WidgetReceiver"
        val receiverClass =
          try {
            Class.forName(receiverName)
          } catch (e: ClassNotFoundException) {
            throw WidgetAndroidException("No widget receiver named $receiverName")
          }
        if (!GlanceAppWidgetReceiver::class.java.isAssignableFrom(receiverClass)) {
          throw WidgetAndroidException("$receiverName is not a GlanceAppWidgetReceiver")
        }
        @Suppress("UNCHECKED_CAST")
        val receiver = receiverClass as Class<GlanceAppWidgetReceiver>
        GlanceAppWidgetManager(context).requestPinGlanceAppWidget(receiver)
      }
    }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw WidgetAndroidException("No React context")
}

private class WidgetAndroidException(
  message: String,
) : CodedException("ERR_WIDGET_ANDROID", message, null)
