import ExpoModulesCore
import Vision

public class ImageClassifierModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ImageClassifier")

    AsyncFunction("classifyImage") { (uri: String, minConfidence: Double) -> [[String: Any]] in
      // NOTE: handles file:// or absolute paths
      let url: URL
      if uri.contains("://") {
        guard let parsed = URL(string: uri) else { throw InvalidImageURIException(uri) }
        url = parsed
      } else {
        url = URL(fileURLWithPath: uri)
      }

      let handler = VNImageRequestHandler(url: url, options: [:])
      let request = VNClassifyImageRequest()

      do {
        try handler.perform([request])
      } catch {
        throw ClassificationFailedException(error.localizedDescription)
      }

      guard let observations = request.results else { return [] }

      return
        observations
        .filter { Double($0.confidence) >= minConfidence }
        .sorted { $0.confidence > $1.confidence }
        .map { ["label": $0.identifier, "confidence": Double($0.confidence)] }
    }
  }
}

private final class InvalidImageURIException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "Invalid image URI: \(param)"
  }
}

private final class ClassificationFailedException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "Image classification failed: \(param)"
  }
}
