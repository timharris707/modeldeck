// swift-tools-version: 6.0
import PackageDescription

// ModelDeck Mac app — SwiftPM package following the PanelyMac conventions
// (no .xcodeproj; library core + executable app + tests; app bundle is
// assembled by Scripts/build_app.sh).
let package = Package(
    name: "ModelDeckMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(name: "ModelDeckMacCore", targets: ["ModelDeckMacCore"]),
        .executable(name: "ModelDeckMac", targets: ["ModelDeckMac"])
    ],
    targets: [
        .target(
            name: "ModelDeckMacCore",
            resources: [
                // Issue #103: official provider desktop-app icons
                // (provider-{claude,codex}-{32,64,128}.png). The build
                // scripts stage the generated ModelDeckMac_ModelDeckMacCore
                // .bundle into the app's Contents/Resources.
                .process("Resources")
            ]
        ),
        .executableTarget(
            name: "ModelDeckMac",
            dependencies: ["ModelDeckMacCore"]
        ),
        .testTarget(
            name: "ModelDeckMacCoreTests",
            dependencies: ["ModelDeckMacCore"]
        )
    ]
)
