// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PandoksSwift",
    platforms: [
        .iOS(.v18),
        .watchOS(.v11),
    ],
    products: [
        .library(
            name: "PandoksSwift",
            targets: ["PandoksSwift"]
        ),
    ],
    targets: [
        .target(name: "PandoksSwift", dependencies: ["PandoksInternal"]),
        .target(name: "PandoksInternal"),
        .testTarget(name: "PandoksSwiftTests", dependencies: ["PandoksSwift"]),
    ]
)
