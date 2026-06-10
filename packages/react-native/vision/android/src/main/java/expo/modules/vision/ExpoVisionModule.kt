package expo.modules.vision

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoVisionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoVision")

    AsyncFunction("setValueAsync") { value: String ->
    }
  }
}
