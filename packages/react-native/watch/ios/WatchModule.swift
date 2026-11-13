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

    AsyncFunction("updateApplicationContext") { (context: [String: Any]) in
      try await self.sessionDelegate.waitForActivation()
      try WCSession.default.updateApplicationContext(context)
    }
  }
}

class WatchSessionDelegate: NSObject, WCSessionDelegate {
  weak var module: WatchModule?
  private let activationLock = NSLock()
  private var activationError: Error?
  private var activationWaiters: [CheckedContinuation<Void, Error>] = []

  init(module: WatchModule) {
    self.module = module
  }

  // NOTE: sends fail until the session activates, at launch and while switching watches
  func waitForActivation() async throws {
    try await withCheckedThrowingContinuation { continuation in
      activationLock.withLock {
        if WCSession.default.activationState == .activated {
          continuation.resume()
        } else if let activationError {
          continuation.resume(throwing: activationError)
        } else {
          activationWaiters.append(continuation)
        }
      }
    }
  }

  // NOTE: both read empty before activation, and activating doesn't count as a change
  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    // NOTE: completes as .inactive when switching watches, and sessionDidDeactivate reactivates
    activationLock.withLock {
      activationError = error
      if let error {
        activationWaiters.forEach { $0.resume(throwing: error) }
      } else if activationState == .activated {
        activationWaiters.forEach { $0.resume() }
      } else {
        return
      }
      activationWaiters.removeAll()
    }
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
