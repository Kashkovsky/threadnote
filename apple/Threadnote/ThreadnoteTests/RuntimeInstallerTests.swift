import Foundation
import XCTest

@testable import Threadnote

final class RuntimeInstallerTests: XCTestCase {
  func testInstallsBundledRuntimeAndStableLaunchers() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let bundled = root.appendingPathComponent("bundled")
    let support = root.appendingPathComponent("support")
    try FileManager.default.createDirectory(
      at: bundled.appendingPathComponent("bin"), withIntermediateDirectories: true)
    try Data("2.0.3\n".utf8).write(to: bundled.appendingPathComponent("version"))
    try Data().write(to: bundled.appendingPathComponent("bin/threadnote-launcher"))
    defer { try? FileManager.default.removeItem(at: root) }

    let installer = RuntimeInstaller(applicationSupportURL: support)
    let installed = try installer.install(bundledRuntime: bundled)

    XCTAssertEqual(installed, support.appendingPathComponent("runtime/current"))
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: support.appendingPathComponent("bin/threadnote").path))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: support.appendingPathComponent("bin/threadnote-mcp-server").path))
    XCTAssertEqual(
      try String(
        contentsOf: support.appendingPathComponent("runtime/current/version"), encoding: .utf8),
      "2.0.3\n"
    )
  }

  func testReplacesCurrentRuntimeWhenContentChangesWithinSameVersion() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let support = root.appendingPathComponent("support")
    defer { try? FileManager.default.removeItem(at: root) }

    let first = try makeRuntime(
      root: root, name: "first", contentID: String(repeating: "a", count: 64))
    let second = try makeRuntime(
      root: root, name: "second", contentID: String(repeating: "b", count: 64))
    let installer = RuntimeInstaller(applicationSupportURL: support)

    _ = try installer.install(bundledRuntime: first)
    _ = try installer.install(bundledRuntime: second)

    XCTAssertEqual(
      try String(
        contentsOf: support.appendingPathComponent("runtime/current/marker"), encoding: .utf8),
      "second"
    )
  }

  func testRefusesToDowngradeTheActiveRuntime() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let support = root.appendingPathComponent("support")
    defer { try? FileManager.default.removeItem(at: root) }

    let newer = try makeRuntime(
      root: root,
      name: "newer",
      contentID: String(repeating: "c", count: 64),
      version: "2.1.0"
    )
    let older = try makeRuntime(
      root: root,
      name: "older",
      contentID: String(repeating: "d", count: 64),
      version: "2.0.3"
    )
    let installer = RuntimeInstaller(applicationSupportURL: support)

    _ = try installer.install(bundledRuntime: newer)
    XCTAssertThrowsError(try installer.install(bundledRuntime: older)) { error in
      XCTAssertEqual(
        error.localizedDescription,
        "Threadnote runtime 2.1.0 is already installed; this app cannot downgrade it to 2.0.3."
      )
    }
    XCTAssertEqual(
      try String(
        contentsOf: support.appendingPathComponent("runtime/current/version"), encoding: .utf8
      ).trimmingCharacters(in: .whitespacesAndNewlines),
      "2.1.0"
    )
  }

  private func makeRuntime(
    root: URL,
    name: String,
    contentID: String,
    version: String = "2.0.3"
  ) throws -> URL {
    let runtime = root.appendingPathComponent(name)
    try FileManager.default.createDirectory(
      at: runtime.appendingPathComponent("bin"), withIntermediateDirectories: true)
    try Data("\(version)\n".utf8).write(to: runtime.appendingPathComponent("version"))
    try Data("\(contentID)\n".utf8).write(to: runtime.appendingPathComponent("content-id"))
    try Data(name.utf8).write(to: runtime.appendingPathComponent("marker"))
    try Data().write(to: runtime.appendingPathComponent("bin/threadnote-launcher"))
    return runtime
  }
}
