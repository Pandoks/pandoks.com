import SwiftUI
import WatchConnectivity

@main
struct WatchApp: App {
  @State private var phoneSession = PhoneSession()

  var body: some Scene {
    WindowGroup {
      VStack(spacing: 12) {
        Text(phoneSession.valueFromPhone ?? "Nothing from phone")
        if let sendError = phoneSession.sendError {
          Text(sendError).font(.footnote).foregroundStyle(.red)
        }
        Button("Send to phone") {
          phoneSession.send(Date.now.formatted(date: .omitted, time: .standard))
        }
        .disabled(!phoneSession.isActivated)
      }
    }
  }
}

@Observable
final class PhoneSession: NSObject, WCSessionDelegate {
  var isActivated = false
  var valueFromPhone: String?
  var sendError: String?

  override init() {
    super.init()
    WCSession.default.delegate = self
    WCSession.default.activate()
  }

  func send(_ value: String) {
    do {
      try WCSession.default.updateApplicationContext(["value": value])
      sendError = nil
    } catch {
      sendError = error.localizedDescription
    }
  }

  func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    DispatchQueue.main.async { self.isActivated = activationState == .activated }
    show(session.receivedApplicationContext)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    show(applicationContext)
  }

  private func show(_ context: [String: Any]) {
    DispatchQueue.main.async { self.valueFromPhone = context["value"] as? String }
  }
}
