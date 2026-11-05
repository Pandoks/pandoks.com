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
        view.setNeedsLayout()
      }
      Prop("color") { (view: ModuleTemplateView, color: UIColor) in
        view.label.textColor = color
      }
    }
  }
}

class ModuleTemplateView: ExpoView {
  let label = UILabel()
  private var reportedSize = CGSize.zero

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    label.numberOfLines = 0
    label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 17))
    label.adjustsFontForContentSizeCategory = true
    addSubview(label)
  }

  // NOTE: Yoga can't measure native views, so report the text's size to wrap like React Native text.
  override func layoutSubviews() {
    super.layoutSubviews()
    let unbounded = CGFloat.greatestFiniteMagnitude
    let lineWidth = ceil(label.sizeThatFits(CGSize(width: unbounded, height: unbounded)).width)
    let wrapWidth = bounds.width > 0 ? min(bounds.width, lineWidth) : lineWidth
    let height = ceil(label.sizeThatFits(CGSize(width: wrapWidth, height: unbounded)).height)
    let size = CGSize(width: lineWidth, height: height)
    if size != reportedSize {
      reportedSize = size
      setViewSize(size)
    }
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    setNeedsLayout()
  }
}
