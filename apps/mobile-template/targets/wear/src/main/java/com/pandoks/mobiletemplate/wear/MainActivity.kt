package com.pandoks.mobiletemplate.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMap
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// NOTE: must match packages/react-native-watch's WatchModule
private const val CONTEXT_PATH = "/application_context"
private const val MESSAGE_PATH = "/message"

class MainActivity : ComponentActivity(), DataClient.OnDataChangedListener {
  private var valueFromPhone by mutableStateOf<String?>(null)
  private var sendError by mutableStateOf<String?>(null)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      MaterialTheme {
        Column(
          Modifier.fillMaxSize().padding(24.dp),
          Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
          Alignment.CenterHorizontally
        ) {
          Text(valueFromPhone ?: "Nothing from phone")
          sendError?.let { error ->
            Text(
              error,
              color = MaterialTheme.colorScheme.error,
              textAlign = TextAlign.Center,
              style = MaterialTheme.typography.bodySmall
            )
          }
          Button(onClick = { send(LocalTime.now().format(DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM))) }) {
            Text("Send to phone")
          }
        }
      }
    }
  }

  override fun onResume() {
    super.onResume()
    Wearable.getDataClient(this).addListener(this)
    Wearable.getDataClient(this).dataItems.addOnSuccessListener { dataItems ->
      dataItems.forEach(::show)
      dataItems.release()
    }
  }

  override fun onPause() {
    super.onPause()
    Wearable.getDataClient(this).removeListener(this)
  }

  override fun onDataChanged(dataEvents: DataEventBuffer) {
    dataEvents
      .filter { dataEvent -> dataEvent.type == DataEvent.TYPE_CHANGED }
      .forEach { dataEvent -> show(dataEvent.dataItem) }
  }

  private fun show(dataItem: DataItem) {
    if (dataItem.uri.path == CONTEXT_PATH) {
      valueFromPhone = DataMapItem.fromDataItem(dataItem).dataMap.getString("value")
    }
  }

  private fun send(value: String) {
    sendError = null
    val message = DataMap().apply { putString("value", value) }.toByteArray()
    Wearable.getNodeClient(this).connectedNodes
      .onSuccessTask { nodes ->
        if (nodes.isEmpty()) error("Phone isn't connected")
        Tasks.whenAll(nodes.map { node -> Wearable.getMessageClient(this).sendMessage(node.id, MESSAGE_PATH, message) })
      }
      .addOnFailureListener { exception -> sendError = exception.localizedMessage }
  }
}
