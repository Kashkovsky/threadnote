import PackageDescription

let package = Package(
  name: "SwiftWorkspace",
  targets: [
    .target(name: "SwiftCore"),
    .target(name: "SwiftApp", dependencies: ["SwiftCore"])
  ]
)
