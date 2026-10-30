import ExpoModulesCore
import React

public class ReservedRegionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ReservedRegions")

    Function("getRegions") { () -> [[String: Any]] in
      var regions: [[String: Any]] = []
      // NOTE: unlike DispatchQueue.main.sync, this still runs while React Native blocks main on JS
      RCTUnsafeExecuteOnMainQueueSync {
        MainActor.assumeIsolated { regions = Utilities.keyWindow()?.reservedRegionRecords() ?? [] }
      }
      return regions
    }

    View(ReservedRegionsView.self) {
      Events("onRegionsChange")
    }
  }
}

class ReservedRegionsView: ExpoView {
  let onRegionsChange = EventDispatcher()
  private var regions: NSArray?

  // NOTE: UIKit re-runs updateConstraints when the regions it read there change
  override class var requiresConstraintBasedLayout: Bool { true }

  override func updateConstraints() {
    super.updateConstraints()
    emitIfChanged()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    emitIfChanged()
  }

  private func emitIfChanged() {
    let current = reservedRegionRecords() as NSArray
    if current != regions {
      regions = current
      onRegionsChange(["regions": current])
    }
  }
}

extension UIView {
  func reservedRegionRecords() -> [[String: Any]] {
    guard #available(iOS 27.1, *) else {
      return []
    }
    let kinds: [(String, UIView.ReservedRegion.Kind)] = [("division", .division), ("occlusion", .occlusion)]
    return kinds.flatMap { name, kind in
      reservedRegions(kind: kind, options: .includeInactive).map { region in
        let frame = convert(region.frame, to: nil)
        return [
          "kind": name,
          "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
          "active": region.isActive
        ]
      }
    }
  }
}
