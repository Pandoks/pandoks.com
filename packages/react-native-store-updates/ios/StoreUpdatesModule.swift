import ExpoModulesCore
import StoreKit

public class StoreUpdatesModule: Module {
  private let productViewControllerDelegate = ProductViewControllerDelegate()

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
      try await Task { @MainActor in
        let productViewController = SKStoreProductViewController()
        productViewController.delegate = self.productViewControllerDelegate
        _ = try await productViewController.loadProduct(withParameters: [
          SKStoreProductParameterITunesItemIdentifier: storeApp.trackId
        ])
        self.appContext?.utilities?.currentViewController()?.present(productViewController, animated: true)
      }.value
    }
  }
}

private class ProductViewControllerDelegate: NSObject, SKStoreProductViewControllerDelegate {
  func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
    viewController.dismiss(animated: true)
  }
}

// NOTE: without a country, the lookup only searches the US store, and it takes the
// storefront's alpha-3 code as alpha-2. The timestamp skips the CDN, which caches
// lookups for up to a day
private func lookUpStoreApp() async throws -> StoreApp? {
  let storefrontCountryCode = await Storefront.current?.countryCode
  var components = URLComponents(string: "https://itunes.apple.com/lookup")!
  components.queryItems = [
    URLQueryItem(name: "bundleId", value: Bundle.main.bundleIdentifier),
    URLQueryItem(
      name: "country",
      value: storefrontCountryCode.flatMap { Locale(identifier: "und_\($0)").region?.identifier }
    ),
    URLQueryItem(name: "timestamp", value: String(Date().timeIntervalSince1970)),
  ]
  let (data, _) = try await URLSession.shared.data(from: components.url!)
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
