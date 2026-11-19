package com.pandoks.mobiletemplate.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SurfaceTransformation
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.lazy.rememberTransformationSpec
import androidx.wear.compose.material3.lazy.transformedHeight
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// NOTE: must match packages/react-native/watch's WatchModule
private const val PHONE_CONTEXT_PATH = "/phone_context"
private const val WATCH_CONTEXT_PATH = "/watch_context"
private const val CONTEXT_KEY = "context"
private const val SENT_AT_KEY = "sentAt"

class MainActivity : ComponentActivity(), DataClient.OnDataChangedListener {
  private var valueFromPhone by mutableStateOf<String?>(null)
  private var sendError by mutableStateOf<String?>(null)
  private var hasReceivedChange = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      MaterialTheme {
        AppScaffold {
          val listState = rememberTransformingLazyColumnState()
          val transformationSpec = rememberTransformationSpec()
          ScreenScaffold(listState) { contentPadding ->
            TransformingLazyColumn(state = listState, contentPadding = contentPadding) {
              item {
                ListHeader(
                  Modifier.fillMaxWidth().transformedHeight(this, transformationSpec),
                  transformation = SurfaceTransformation(transformationSpec)
                ) {
                  Text(valueFromPhone ?: "Nothing from phone", textAlign = TextAlign.Center)
                }
              }
              sendError?.let { error ->
                item {
                  Text(
                    error,
                    Modifier.fillMaxWidth().transformedHeight(this, transformationSpec),
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodySmall
                  )
                }
              }
              item {
                Button(
                  onClick = { send(LocalTime.now().format(DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM))) },
                  Modifier.fillMaxWidth().transformedHeight(this, transformationSpec),
                  transformation = SurfaceTransformation(transformationSpec)
                ) {
                  Text("Send to phone")
                }
              }
            }
          }
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    // NOTE: read the current item only once the listener registers, so no change slips between them
    hasReceivedChange = false
    val dataClient = Wearable.getDataClient(this)
    dataClient.addListener(this).onSuccessTask { dataClient.dataItems }.addOnSuccessListener { dataItems ->
      if (!hasReceivedChange) dataItems.forEach(::show)
      dataItems.release()
    }
  }

  override fun onPause() {
    super.onPause()
    Wearable.getDataClient(this).removeListener(this)
  }

  override fun onDataChanged(dataEvents: DataEventBuffer) {
    dataEvents
      .filter { dataEvent -> dataEvent.type == DataEvent.TYPE_CHANGED && dataEvent.dataItem.uri.path == PHONE_CONTEXT_PATH }
      .forEach { dataEvent ->
        hasReceivedChange = true
        show(dataEvent.dataItem)
      }
  }

  private fun show(dataItem: DataItem) {
    if (dataItem.uri.path == PHONE_CONTEXT_PATH) {
      valueFromPhone = DataMapItem.fromDataItem(dataItem).dataMap.getString("value")
    }
  }

  private fun send(value: String) {
    val request = PutDataMapRequest.create(WATCH_CONTEXT_PATH)
    request.dataMap.putDataMap(CONTEXT_KEY, DataMap().apply { putString("value", value) })
    request.dataMap.putLong(SENT_AT_KEY, System.currentTimeMillis())
    Wearable.getDataClient(this).putDataItem(request.asPutDataRequest().setUrgent())
      .addOnSuccessListener { sendError = null }
      .addOnFailureListener { exception -> sendError = exception.localizedMessage }
  }
}
