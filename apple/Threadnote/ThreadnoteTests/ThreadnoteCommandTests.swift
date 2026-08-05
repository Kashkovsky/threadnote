import Foundation
import XCTest

@testable import Threadnote

final class ThreadnoteCommandTests: XCTestCase {
  func testFindsFirstExecutableCandidate() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let missing = directory.appendingPathComponent("missing")
    let executable = directory.appendingPathComponent("threadnote")
    try Data().write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

    let command = ThreadnoteCommandLocator.firstExecutable(in: [
      ThreadnoteCommand(executable: missing),
      ThreadnoteCommand(executable: executable),
    ])

    XCTAssertEqual(command?.executable, executable)
  }

  func testBundledCommandUsesPrivateNodeAndEntryPoint() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let node = root.appendingPathComponent("bin/node")
    let entry = root.appendingPathComponent("threadnote/bin/threadnote.cjs")
    try FileManager.default.createDirectory(
      at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: entry.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: node)
    try Data().write(to: entry)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
    defer { try? FileManager.default.removeItem(at: root) }

    let command = ThreadnoteCommandLocator.bundledCommand(runtimeRoot: root)

    XCTAssertEqual(command?.executable, node)
    XCTAssertEqual(command?.prefixArguments, [entry.path])
  }

  func testStableLaunchersEnableAppManagedEnvironment() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let applicationSupport = root.appendingPathComponent("Application Support/Threadnote")
    let paths = ThreadnotePaths(applicationSupportURL: applicationSupport, homeURL: root)
    try FileManager.default.createDirectory(
      at: paths.stableCommandURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    for launcher in [paths.stableCommandURL, paths.stableMCPCommandURL] {
      try Data().write(to: launcher)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: launcher.path)
    }
    defer { try? FileManager.default.removeItem(at: root) }

    let environment = ThreadnoteCommandLocator(
      paths: paths,
      bundleResourceURL: nil,
      environment: ["PATH": "/usr/bin"]
    ).runtimeEnvironment()

    XCTAssertEqual(environment["THREADNOTE_APP_MANAGED"], "1")
    XCTAssertEqual(
      environment["THREADNOTE_MCP_ADAPTER_COMMAND"], paths.stableMCPCommandURL.path)
    XCTAssertTrue(environment["PATH", default: ""].contains(applicationSupport.path))
  }

  func testExplicitExecutableOverridesStableLauncher() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let paths = ThreadnotePaths(
      applicationSupportURL: root.appendingPathComponent("Application Support/Threadnote"),
      homeURL: root
    )
    let explicit = root.appendingPathComponent("development/threadnote")
    for executable in [paths.stableCommandURL, explicit] {
      try FileManager.default.createDirectory(
        at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data().write(to: executable)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o755], ofItemAtPath: executable.path)
    }
    defer { try? FileManager.default.removeItem(at: root) }

    let command = ThreadnoteCommandLocator(
      paths: paths,
      bundleResourceURL: nil,
      environment: ["THREADNOTE_EXECUTABLE": explicit.path]
    ).locate()

    XCTAssertEqual(command?.executable, explicit)
  }
}
