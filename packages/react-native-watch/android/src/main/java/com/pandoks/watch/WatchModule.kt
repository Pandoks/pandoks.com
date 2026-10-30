package com.pandoks.watch

import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.MessageClient
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// NOTE: the Wear OS app declares this capability and uses these paths
private const val WATCH_CAPABILITY = "watch_app"
private const val CONTEXT_PATH = "/application_context"
private const val MESSAGE_PATH = "/message"

class WatchModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private var isReachable = false

  private val messageListener = MessageClient.OnMessageReceivedListener { messageEvent ->
    if (messageEvent.path == MESSAGE_PATH) {
      sendEvent("onMessage", DataMap.fromByteArray(messageEvent.data).toBundle())
    }
  }
  private val capabilityListener = CapabilityClient.OnCapabilityChangedListener { updateReachability() }

  override fun definition() = ModuleDefinition {
    Name("Watch")

    Events("onMessage", "onReachabilityChange")

    Constant("isSupported") { true }

    Property("isReachable") { isReachable }

    OnCreate {
      Wearable.getMessageClient(context).addListener(messageListener)
      Wearable.getCapabilityClient(context).addListener(capabilityListener, WATCH_CAPABILITY)
      updateReachability()
    }

    OnDestroy {
      Wearable.getMessageClient(context).removeListener(messageListener)
      Wearable.getCapabilityClient(context).removeListener(capabilityListener, WATCH_CAPABILITY)
    }

    Function("updateApplicationContext") { applicationContext: Map<String, Any> ->
      val request = PutDataMapRequest.create(CONTEXT_PATH)
      applicationContext.forEach { (key, value) ->
        when (value) {
          is String -> request.dataMap.putString(key, value)
          is Double -> request.dataMap.putDouble(key, value)
          is Boolean -> request.dataMap.putBoolean(key, value)
        }
      }
      // NOTE: waits for Play services so failures throw like on iOS
      Tasks.await(Wearable.getDataClient(context).putDataItem(request.asPutDataRequest().setUrgent()))
      Unit
    }
  }

  private fun updateReachability() {
    Wearable.getCapabilityClient(context)
      .getCapability(WATCH_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .addOnSuccessListener { capabilityInfo ->
        val reachable = capabilityInfo.nodes.isNotEmpty()
        if (reachable != isReachable) {
          isReachable = reachable
          sendEvent("onReachabilityChange", mapOf("isReachable" to reachable))
        }
      }
  }
}
