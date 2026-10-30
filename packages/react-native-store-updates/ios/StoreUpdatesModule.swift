import ExpoModulesCore
import StoreKit

public class StoreUpdatesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StoreUpdates")

    AsyncFunction("checkForStoreUpdate") { () async throws -> [String: Any] in
      guard let storeApp = try await lookUpStoreApp() else { return ["available": false] }
      let installedVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String
      let systemVersion = await UIDevice.current.systemVersion
      let available =
        storeApp.version.compare(installedVersion, options: .numeric) == .orderedDescending
        && systemVersion.compare(storeApp.minimumOsVersion, options: .numeric) != .orderedAscending
      return ["available": available, "storeVersion": storeApp.version]
    }

    AsyncFunction("startStoreUpdate") { (_: String) async throws in
      guard let storeApp = try await lookUpStoreApp() else {
        throw Exception(name: "NotInAppStore", description: "This app isn't in the App Store")
      }
      await MainActor.run {
        let productViewController = SKStoreProductViewController()
        productViewController.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: storeApp.trackId])
        self.appContext?.utilities?.currentViewController()?.present(productViewController, animated: true)
      }
    }
  }
}

// NOTE: without a country, the lookup only searches the US store
private func lookUpStoreApp() async throws -> StoreApp? {
  var components = URLComponents(string: "https://itunes.apple.com/lookup")!
  components.queryItems = [
    URLQueryItem(name: "bundleId", value: Bundle.main.bundleIdentifier),
    URLQueryItem(name: "country", value: Locale.current.region?.identifier),
  ]
  let request = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData)
  let (data, _) = try await URLSession.shared.data(for: request)
  return try JSONDecoder().decode(LookupResponse.self, from: data).results.first
}

private struct LookupResponse: Decodable {
  let results: [StoreApp]
}

private struct StoreApp: Decodable {
  let trackId: Int
  let version: String
  let minimumOsVersion: String
}
