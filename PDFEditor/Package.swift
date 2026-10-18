// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PDFEditor",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "PDFEditor", targets: ["PDFEditor"]),
        .library(name: "PDFEditorCore", targets: ["PDFEditorCore"]),
    ],
    targets: [
        .target(
            name: "PDFEditorCore",
            path: "Sources/PDFEditorCore"
        ),
        .executableTarget(
            name: "PDFEditor",
            dependencies: ["PDFEditorCore"],
            path: "Sources/PDFEditor"
        ),
        .testTarget(
            name: "PDFEditorCoreTests",
            dependencies: ["PDFEditorCore"],
            path: "Tests/PDFEditorCoreTests"
        ),
    ]
)
