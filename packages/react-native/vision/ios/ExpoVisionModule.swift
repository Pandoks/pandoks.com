import ExpoModulesCore

public class ExpoVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoVision")

    AsyncFunction("setValueAsync") { (value: String) in
    }
  }
}
