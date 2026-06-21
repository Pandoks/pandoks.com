package com.pandoks.mobiletemplate.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { WearApp() }
  }
}

@Composable
fun WearApp() {
  MaterialTheme {
    Column(
      modifier = Modifier.fillMaxSize().padding(8.dp),
      verticalArrangement = Arrangement.Center,
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(text = "Mobile Template", style = MaterialTheme.typography.titleMedium)
      Text(text = "Wear OS", style = MaterialTheme.typography.bodyLarge)
    }
  }
}
