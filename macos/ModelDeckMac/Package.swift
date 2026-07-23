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
    dependencies: [
        // Issue #121 — in-app updates. Pinned EXACT so a release build can
        // never silently pick up a new updater; bumps are deliberate PRs.
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.8.0")
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
            dependencies: [
                "ModelDeckMacCore",
                // Sparkle stays OUT of ModelDeckMacCore on purpose: the core
                // library holds the testable state machines; only the app
                // target links the updater framework (seam: AppUpdateInstalling).
                .product(name: "Sparkle", package: "Sparkle")
            ]
        ),
        .testTarget(
            name: "ModelDeckMacCoreTests",
            dependencies: ["ModelDeckMacCore"]
        )
    ]
)
