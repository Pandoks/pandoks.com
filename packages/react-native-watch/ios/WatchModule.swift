import ExpoModulesCore
import WatchConnectivity

public class WatchModule: Module {
  private lazy var sessionDelegate = WatchSessionDelegate(module: self)

  public func definition() -> ModuleDefinition {
    Name("Watch")

    Events("onApplicationContext", "onReachabilityChange")

    Constant("isSupported") { WCSession.isSupported() }

    Property("isReachable") { WCSession.default.isReachable }

    Property("receivedApplicationContext") { WCSession.default.receivedApplicationContext }

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

  // NOTE: both read empty before activation, and activating doesn't count as a change
  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    module?.sendEvent("onReachabilityChange", ["isReachable": session.isReachable])
    module?.sendEvent("onApplicationContext", session.receivedApplicationContext)
  }

  func sessionDidBecomeInactive(_ session: WCSession) {}

  // NOTE: reactivates for the new watch when the user switches watches
  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    module?.sendEvent("onReachabilityChange", ["isReachable": session.isReachable])
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    module?.sendEvent("onApplicationContext", applicationContext)
  }
}
