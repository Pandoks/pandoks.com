package com.pandoks.watch

import android.os.Bundle
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataMap
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
  private var reachabilityRequest = 0
  private var receivedApplicationContext = Bundle()
  private var hasReceivedChange = false

  private val dataListener = DataClient.OnDataChangedListener { dataEvents ->
    dataEvents
      .filter { dataEvent -> dataEvent.type == DataEvent.TYPE_CHANGED && dataEvent.dataItem.uri.path == WATCH_CONTEXT_PATH }
      .forEach { dataEvent ->
        hasReceivedChange = true
        receive(DataMapItem.fromDataItem(dataEvent.dataItem).dataMap)
      }
  }
  private val capabilityListener = CapabilityClient.OnCapabilityChangedListener { updateReachability() }

  override fun definition() = ModuleDefinition {
    Name("Watch")

    Events("onApplicationContext", "onReachabilityChange")

    Constant("isSupported") { true }

    Property("isReachable") { isReachable }

    Property("receivedApplicationContext") { receivedApplicationContext }

    // NOTE: read the current state only once each listener registers, so no change slips between them
    OnCreate {
      Wearable.getCapabilityClient(context)
        .addListener(capabilityListener, WATCH_CAPABILITY)
        .addOnSuccessListener { updateReachability() }
      // NOTE: the watch's data item outlives both apps, so read what it sent while this one wasn't running
      val dataClient = Wearable.getDataClient(context)
      dataClient.addListener(dataListener).onSuccessTask { dataClient.dataItems }.addOnSuccessListener { dataItems ->
        // NOTE: each watch keeps its own item, so take the one sent last, unless a change already arrived
        val newestDataMap = dataItems
          .filter { dataItem -> dataItem.uri.path == WATCH_CONTEXT_PATH }
          .map { dataItem -> DataMapItem.fromDataItem(dataItem).dataMap }
          .maxByOrNull { dataMap -> dataMap.getLong(SENT_AT_KEY) }
        dataItems.release()
        if (!hasReceivedChange) newestDataMap?.let(::receive)
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

  private fun receive(dataMap: DataMap) {
    receivedApplicationContext = requireNotNull(dataMap.getDataMap(CONTEXT_KEY)).toBundle()
    sendEvent("onApplicationContext", receivedApplicationContext)
  }

  private fun updateReachability() {
    // NOTE: lookups can complete out of order, so apply only the latest
    val request = ++reachabilityRequest
    Wearable.getCapabilityClient(context)
      .getCapability(WATCH_CAPABILITY, CapabilityClient.FILTER_REACHABLE)
      .addOnCompleteListener { task ->
        if (request != reachabilityRequest) return@addOnCompleteListener
        isReachable = task.isSuccessful && task.result.nodes.isNotEmpty()
        sendEvent("onReachabilityChange", mapOf("isReachable" to isReachable))
      }
  }
}
