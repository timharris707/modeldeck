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
        .target(name: "ModelDeckMacCore"),
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
