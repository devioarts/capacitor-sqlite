// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DevioartsCapacitorSqlite",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "DevioartsCapacitorSqlite",
            targets: ["CapacitorSqlitePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "CapacitorSqlitePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CapacitorSqlitePlugin",
            linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(
            name: "CapacitorSqlitePluginTests",
            dependencies: ["CapacitorSqlitePlugin"],
            path: "ios/Tests/CapacitorSqlitePluginTests")
    ]
)
