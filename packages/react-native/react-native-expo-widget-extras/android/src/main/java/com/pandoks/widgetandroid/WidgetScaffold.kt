package com.pandoks.widgetandroid

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding

// The standard widget chrome — Material theme, rounded surface, padding (can override)
@Composable
fun WidgetScaffold(
  horizontalAlignment: Alignment.Horizontal = Alignment.Start,
  verticalAlignment: Alignment.Vertical = Alignment.Top,
  content: @Composable ColumnScope.() -> Unit,
) {
  GlanceTheme {
    Column(
      modifier =
        GlanceModifier
          .fillMaxSize()
          .appWidgetBackground()
          .background(GlanceTheme.colors.widgetBackground)
          .cornerRadius(16.dp)
          .padding(12.dp),
      horizontalAlignment = horizontalAlignment,
      verticalAlignment = verticalAlignment,
      content = content,
    )
  }
}
