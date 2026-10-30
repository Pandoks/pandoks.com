import ExpoModulesCore
import StoreKit

public class StoreUpdatesModule: Module {
  private var appStoreId: Int?

  public func definition() -> ModuleDefinition {
    Name("StoreUpdates")

    AsyncFunction("checkForStoreUpdate") { () async throws -> [String: Any] in
      let url = URL(string: "https://itunes.apple.com/lookup?bundleId=\(Bundle.main.bundleIdentifier!)")!
      let (data, _) = try await URLSession.shared.data(from: url)
      guard let storeApp = try JSONDecoder().decode(LookupResponse.self, from: data).results.first else {
        return ["available": false]
      }
      self.appStoreId = storeApp.trackId
      let installedVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String
      let systemVersion = await UIDevice.current.systemVersion
      let available =
        storeApp.version.compare(installedVersion, options: .numeric) == .orderedDescending
        && systemVersion.compare(storeApp.minimumOsVersion, options: .numeric) != .orderedAscending
      return ["available": available, "storeVersion": storeApp.version]
    }

    AsyncFunction("startStoreUpdate") { (_: String) in
      let productViewController = SKStoreProductViewController()
      productViewController.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: self.appStoreId!])
      self.appContext?.utilities?.currentViewController()?.present(productViewController, animated: true)
    }.runOnQueue(.main)
  }
}

private struct LookupResponse: Decodable {
  let results: [StoreApp]
}

private struct StoreApp: Decodable {
  let trackId: Int
  let version: String
  let minimumOsVersion: String
}
