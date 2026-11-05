package com.pandoks.watch

import android.os.Bundle
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// NOTE: the Wear OS app declares this capability and uses these paths
private const val WATCH_CAPABILITY = "watch_app"
private const val PHONE_CONTEXT_PATH = "/phone_context"
private const val WATCH_CONTEXT_PATH = "/watch_context"
private const val CONTEXT_KEY = "context"
private const val SENT_AT_KEY = "sentAt"

class WatchModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)
  private var isReachable = false
  private var receivedApplicationContext = Bundle()
  private var receivedSentAt = Long.MIN_VALUE

  private val dataListener = DataClient.OnDataChangedListener { dataEvents ->
    dataEvents
      .filter { dataEvent -> dataEvent.type == DataEvent.TYPE_CHANGED }
      .forEach { dataEvent -> receive(dataEvent.dataItem) }
  }
  private val capabilityListener = CapabilityClient.OnCapabilityChangedListener { updateReachability() }

  override fun definition() = ModuleDefinition {
    Name("Watch")

    Events("onApplicationContext", "onReachabilityChange")

    Constant("isSupported") { true }

    Property("isReachable") { isReachable }

    Property("receivedApplicationContext") { receivedApplicationContext }

    OnCreate {
      Wearable.getDataClient(context).addListener(dataListener)
      Wearable.getCapabilityClient(context).addListener(capabilityListener, WATCH_CAPABILITY)
      updateReachability()
      // NOTE: the watch's data item outlives both apps, so read what it sent while this one wasn't running
      Wearable.getDataClient(context).dataItems.addOnSuccessListener { dataItems ->
        dataItems.forEach(::receive)
        dataItems.release()
      }
    }

    OnDestroy {
      Wearable.getDataClient(context).removeListener(dataListener)
      Wearable.getCapabilityClient(context).removeListener(capabilityListener, WATCH_CAPABILITY)
    }

    AsyncFunction("updateApplicationContext") { applicationContext: Map<String, Any> ->
      val request = PutDataMapRequest.create(PHONE_CONTEXT_PATH)
      applicationContext.forEach { (key, value) ->
        when (value) {
          is String -> request.dataMap.putString(key, value)
          is Double -> request.dataMap.putDouble(key, value)
          is Boolean -> request.dataMap.putBoolean(key, value)
        }
      }
      // NOTE: resolves once Play services stores the item and rejects with its error, like on iOS
      Tasks.await(Wearable.getDataClient(context).putDataItem(request.asPutDataRequest().setUrgent()))
      Unit
    }
  }

  private fun receive(dataItem: DataItem) {
    if (dataItem.uri.path == WATCH_CONTEXT_PATH) {
      // NOTE: each watch keeps its own item, so keep the newest across watches
      val dataMap = DataMapItem.fromDataItem(dataItem).dataMap
      val sentAt = dataMap.getLong(SENT_AT_KEY)
      if (sentAt < receivedSentAt) return
      receivedSentAt = sentAt
      receivedApplicationContext = requireNotNull(dataMap.getDataMap(CONTEXT_KEY)).toBundle()
      sendEvent("onApplicationContext", receivedApplicationContext)
    }
  }

  private fun updateReachability() {
    Wearable.getCapabilityClient(context)
      .getCapability(WATCH_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .addOnSuccessListener { capabilityInfo ->
        isReachable = capabilityInfo.nodes.isNotEmpty()
        sendEvent("onReachabilityChange", mapOf("isReachable" to isReachable))
      }
  }
}
