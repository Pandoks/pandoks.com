import ExpoModulesCore
import WatchConnectivity

public class WatchModule: Module {
  private lazy var sessionDelegate = WatchSessionDelegate(module: self)

  public func definition() -> ModuleDefinition {
    Name("Watch")

    Events("onMessage", "onReachabilityChange")

    Constant("isSupported") { WCSession.isSupported() }

    Property("isReachable") { WCSession.default.isReachable }

    OnCreate {
      if WCSession.isSupported() {
        WCSession.default.delegate = self.sessionDelegate
        WCSession.default.activate()
      }
    }

    Function("updateApplicationContext") { (context: [String: Any]) in
      try WCSession.default.updateApplicationContext(context)
    }
  }
}

class WatchSessionDelegate: NSObject, WCSessionDelegate {
  weak var module: WatchModule?

  init(module: WatchModule) {
    self.module = module
  }

  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  // NOTE: reactivates for the new watch when the user switches watches
  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    module?.sendEvent("onReachabilityChange", ["isReachable": session.isReachable])
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    module?.sendEvent("onMessage", message)
  }
}
