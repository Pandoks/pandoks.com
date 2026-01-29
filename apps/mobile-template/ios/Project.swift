import ProjectDescription

let project = Project(
    name: "MobileTemplate",
    organizationName: "Pandoks",
    targets: [
        .target(
            name: "MobileTemplate",
            destinations: .iOS,
            product: .app,
            bundleId: "com.pandoks.MobileTemplate",
            infoPlist: .extendingDefault(with: [
                "UILaunchScreen": [
                    "UIColorName": "",
                    "UIImageName": "",
                ],
            ]),
            buildableFolders: [
                "MobileTemplate/Sources",
                "MobileTemplate/Resources",
            ],
            dependencies: [
                .external(name: "PandoksSwift"),
                .external(name: "ComposableArchitecture"),
                .target(name: "MobileTemplateWidget"),
            ]
        ),
        .target(
            name: "MobileTemplateTests",
            destinations: .iOS,
            product: .unitTests,
            bundleId: "com.pandoks.MobileTemplateTests",
            infoPlist: .default,
            buildableFolders: [
                "MobileTemplate/Tests",
            ],
            dependencies: [
                .target(name: "MobileTemplate"),
            ]
        ),
        .target(
            name: "MobileTemplateWatch",
            destinations: [.appleWatch],
            product: .app,
            bundleId: "com.pandoks.MobileTemplate.watchkitapp",
            infoPlist: .extendingDefault(with: [
                "WKApplication": true,
            ]),
            buildableFolders: [
                "MobileTemplateWatch/Sources",
                "MobileTemplateWatch/Resources",
            ],
            dependencies: [
                .external(name: "PandoksSwift"),
            ]
        ),
        .target(
            name: "MobileTemplateWatchTests",
            destinations: [.appleWatch],
            product: .unitTests,
            bundleId: "com.pandoks.MobileTemplateWatchTests",
            infoPlist: .default,
            buildableFolders: [
                "MobileTemplateWatch/Tests",
            ],
            dependencies: [
                .target(name: "MobileTemplateWatch"),
            ]
        ),
    ]
)
