import ExpoModulesCore

public class ModuleTemplateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ModuleTemplate")

    Events("onChange")

    Function("getGreeting") {
      Bundle.main.object(forInfoDictionaryKey: "ModuleTemplateGreeting") as? String
    }

    AsyncFunction("setValueAsync") { (value: String) in
      self.sendEvent("onChange", ["value": value])
    }

    View(ModuleTemplateView.self) {
      Prop("text") { (view: ModuleTemplateView, text: String) in
        view.label.text = text
      }
    }
  }
}

class ModuleTemplateView: ExpoView {
  let label = UILabel()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(label)
  }
}
