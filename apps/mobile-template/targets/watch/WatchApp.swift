import SwiftUI
import WatchConnectivity

@main
struct WatchApp: App {
  @State private var phoneSession = PhoneSession()

  var body: some Scene {
    WindowGroup {
      VStack(spacing: 12) {
        Text(phoneSession.valueFromPhone ?? "Nothing from phone")
        Button("Send to phone") {
          phoneSession.send(Date.now.formatted(date: .omitted, time: .standard))
        }
      }
    }
  }
}

@Observable
final class PhoneSession: NSObject, WCSessionDelegate {
  var valueFromPhone: String?

  override init() {
    super.init()
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func send(_ value: String) {
    WCSession.default.sendMessage(["value": value], replyHandler: nil)
  }

  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    show(session.receivedApplicationContext)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    show(applicationContext)
  }

  private func show(_ context: [String: Any]) {
    DispatchQueue.main.async { self.valueFromPhone = context["value"] as? String }
  }
}
