import Darwin
import Foundation

struct ThreadnoteCommand: Equatable, Sendable {
  let executable: URL
  var prefixArguments: [String] = []
  var environment: [String: String] = [:]

  func arguments(_ arguments: [String]) -> [String] {
    prefixArguments + arguments
  }
}

struct ThreadnotePaths: Sendable {
  let applicationSupportURL: URL
  let homeURL: URL

  init(
    applicationSupportURL: URL = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Threadnote", isDirectory: true),
    homeURL: URL = FileManager.default.homeDirectoryForCurrentUser
  ) {
    self.applicationSupportURL = applicationSupportURL
    self.homeURL = homeURL
  }

  var stableCommandURL: URL { applicationSupportURL.appendingPathComponent("bin/threadnote") }
  var stableMCPCommandURL: URL {
    applicationSupportURL.appendingPathComponent("bin/threadnote-mcp-server")
  }
  var installedRuntimeURL: URL {
    applicationSupportURL.appendingPathComponent("runtime/current", isDirectory: true)
  }
  var legacyLaunchAgentURL: URL {
    homeURL.appendingPathComponent("Library/LaunchAgents/io.threadnote.openviking.plist")
  }
  var openVikingLogURL: URL { homeURL.appendingPathComponent(".openviking/logs/server.log") }
  var openVikingUserDataURL: URL {
    homeURL.appendingPathComponent(".openviking/data/viking/local/user", isDirectory: true)
  }
}

struct ThreadnoteCommandLocator: Sendable {
  let paths: ThreadnotePaths
  let bundleResourceURL: URL?
  let environment: [String: String]

  init(
    paths: ThreadnotePaths = ThreadnotePaths(),
    bundleResourceURL: URL? = Bundle.main.resourceURL,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.paths = paths
    self.bundleResourceURL = bundleResourceURL
    self.environment = environment
  }

  func locate() -> ThreadnoteCommand? {
    if let override = environment["THREADNOTE_EXECUTABLE"], !override.isEmpty {
      let command = ThreadnoteCommand(executable: URL(fileURLWithPath: override))
      if FileManager.default.isExecutableFile(atPath: command.executable.path) {
        return command.with(environment: runtimeEnvironment())
      }
    }
    if FileManager.default.isExecutableFile(atPath: paths.stableCommandURL.path) {
      return ThreadnoteCommand(
        executable: paths.stableCommandURL, environment: runtimeEnvironment())
    }
    if let command = Self.bundledCommand(runtimeRoot: paths.installedRuntimeURL) {
      return command.with(environment: runtimeEnvironment())
    }
    if let bundled = bundleResourceURL?.appendingPathComponent("AppRuntime", isDirectory: true),
      let command = Self.bundledCommand(runtimeRoot: bundled)
    {
      return command.with(environment: runtimeEnvironment(runtimeRoot: bundled))
    }

    var candidates: [ThreadnoteCommand] = []
    candidates += executableSearchDirectories().map {
      ThreadnoteCommand(executable: $0.appendingPathComponent("threadnote"))
    }
    return Self.firstExecutable(in: candidates)?.with(environment: runtimeEnvironment())
  }

  static func bundledCommand(runtimeRoot: URL) -> ThreadnoteCommand? {
    let node = runtimeRoot.appendingPathComponent("bin/node")
    let entry = runtimeRoot.appendingPathComponent("threadnote/bin/threadnote.cjs")
    guard
      FileManager.default.isExecutableFile(atPath: node.path),
      FileManager.default.fileExists(atPath: entry.path)
    else {
      return nil
    }
    return ThreadnoteCommand(executable: node, prefixArguments: [entry.path])
  }

  static func firstExecutable(in candidates: [ThreadnoteCommand]) -> ThreadnoteCommand? {
    candidates.first { FileManager.default.isExecutableFile(atPath: $0.executable.path) }
  }

  func bundledRuntimeURL() -> URL? {
    guard let url = bundleResourceURL?.appendingPathComponent("AppRuntime", isDirectory: true),
      FileManager.default.fileExists(atPath: url.appendingPathComponent("version").path)
    else {
      return nil
    }
    return url
  }

  func runtimeEnvironment(runtimeRoot: URL? = nil) -> [String: String] {
    let installedRoot = runtimeRoot ?? paths.installedRuntimeURL
    let pathEntries = [
      paths.applicationSupportURL.appendingPathComponent("bin").path,
      installedRoot.appendingPathComponent("bin").path,
      paths.homeURL.appendingPathComponent(".local/bin").path,
      paths.homeURL.appendingPathComponent(".bun/bin").path,
      paths.homeURL.appendingPathComponent(".deno/bin").path,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]
    var values = environment
    let inherited = environment["PATH"]?.split(separator: ":").map(String.init) ?? []
    values["PATH"] = Array(NSOrderedSet(array: pathEntries + inherited))
      .compactMap { $0 as? String }
      .joined(separator: ":")
    if FileManager.default.isExecutableFile(atPath: paths.stableCommandURL.path),
      FileManager.default.isExecutableFile(atPath: paths.stableMCPCommandURL.path)
    {
      values["THREADNOTE_APP_MANAGED"] = "1"
      values["THREADNOTE_BIN_DIR"] = paths.applicationSupportURL.appendingPathComponent("bin").path
      values["THREADNOTE_MCP_ADAPTER_COMMAND"] = paths.stableMCPCommandURL.path
    }
    return values
  }

  private func executableSearchDirectories() -> [URL] {
    let path =
      environment["PATH"]?.split(separator: ":").map { URL(fileURLWithPath: String($0)) } ?? []
    return path + [
      paths.homeURL.appendingPathComponent(".local/bin"),
      paths.homeURL.appendingPathComponent(".bun/bin"),
      paths.homeURL.appendingPathComponent(".deno/bin"),
      URL(fileURLWithPath: "/opt/homebrew/bin"),
      URL(fileURLWithPath: "/usr/local/bin"),
    ]
  }
}

extension ThreadnoteCommand {
  fileprivate func with(environment: [String: String]) -> ThreadnoteCommand {
    ThreadnoteCommand(
      executable: executable, prefixArguments: prefixArguments, environment: environment)
  }
}

struct RuntimeInstaller: Sendable {
  let applicationSupportURL: URL

  func install(bundledRuntime: URL) throws -> URL {
    let fileManager = FileManager.default
    let rawVersion = try String(
      contentsOf: bundledRuntime.appendingPathComponent("version"), encoding: .utf8
    )
    .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !rawVersion.isEmpty,
      rawVersion.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    else {
      throw RuntimeInstallerError.invalidVersion
    }
    let contentID = try? String(
      contentsOf: bundledRuntime.appendingPathComponent("content-id"), encoding: .utf8
    )
    .trimmingCharacters(in: .whitespacesAndNewlines)
    if let contentID,
      contentID.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) == nil
    {
      throw RuntimeInstallerError.invalidContentID
    }
    let installationID =
      contentID.map { "\(rawVersion)-\($0.prefix(12).lowercased())" } ?? rawVersion

    let runtimeDirectory = applicationSupportURL.appendingPathComponent(
      "runtime", isDirectory: true)
    let current = runtimeDirectory.appendingPathComponent("current")
    if let bundledVersion = SemanticVersion(rawVersion),
      let installedRawVersion = try? String(
        contentsOf: current.appendingPathComponent("version"), encoding: .utf8
      ).trimmingCharacters(in: .whitespacesAndNewlines),
      let installedVersion = SemanticVersion(installedRawVersion),
      bundledVersion < installedVersion
    {
      throw RuntimeInstallerError.downgradeNotAllowed(
        installed: installedRawVersion,
        bundled: rawVersion
      )
    }
    let versionsDirectory = runtimeDirectory.appendingPathComponent("versions", isDirectory: true)
    let versionDirectory = versionsDirectory.appendingPathComponent(
      installationID, isDirectory: true)
    try fileManager.createDirectory(
      at: versionsDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])

    if !fileManager.fileExists(atPath: versionDirectory.path) {
      let staging = versionsDirectory.appendingPathComponent(
        ".staging-\(UUID().uuidString)", isDirectory: true)
      do {
        try fileManager.copyItem(at: bundledRuntime, to: staging)
        try fileManager.moveItem(at: staging, to: versionDirectory)
      } catch {
        try? fileManager.removeItem(at: staging)
        throw error
      }
    }

    let pendingLink = runtimeDirectory.appendingPathComponent(".current-\(UUID().uuidString)")
    try fileManager.createSymbolicLink(
      atPath: pendingLink.path, withDestinationPath: "versions/\(installationID)")
    if rename(pendingLink.path, current.path) != 0 {
      try? fileManager.removeItem(at: pendingLink)
      throw RuntimeInstallerError.couldNotActivate(errno)
    }

    try installLaunchers(from: versionDirectory)
    return current
  }

  private func installLaunchers(from runtime: URL) throws {
    let fileManager = FileManager.default
    let source = runtime.appendingPathComponent("bin/threadnote-launcher")
    guard fileManager.fileExists(atPath: source.path) else {
      throw RuntimeInstallerError.missingLauncher
    }
    let bin = applicationSupportURL.appendingPathComponent("bin", isDirectory: true)
    try fileManager.createDirectory(
      at: bin, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    for name in ["threadnote", "threadnote-mcp-server"] {
      let destination = bin.appendingPathComponent(name)
      let staging = bin.appendingPathComponent(".\(name)-\(UUID().uuidString)")
      try fileManager.copyItem(at: source, to: staging)
      try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: staging.path)
      if rename(staging.path, destination.path) != 0 {
        try? fileManager.removeItem(at: staging)
        throw RuntimeInstallerError.couldNotActivate(errno)
      }
    }
  }
}

enum RuntimeInstallerError: LocalizedError {
  case couldNotActivate(Int32)
  case downgradeNotAllowed(installed: String, bundled: String)
  case invalidVersion
  case invalidContentID
  case missingLauncher

  var errorDescription: String? {
    switch self {
    case .couldNotActivate(let code): "Could not activate the app-managed runtime (errno \(code))."
    case .downgradeNotAllowed(let installed, let bundled):
      "Threadnote runtime \(installed) is already installed; this app cannot downgrade it to \(bundled)."
    case .invalidVersion: "The bundled Threadnote runtime has an invalid version."
    case .invalidContentID: "The bundled Threadnote runtime has an invalid content ID."
    case .missingLauncher: "The bundled Threadnote runtime is missing its signed launcher."
    }
  }
}

private struct SemanticVersion: Comparable {
  let major: Int
  let minor: Int
  let patch: Int
  let prerelease: [String]?

  init?(_ value: String) {
    let pattern = #"^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"#
    guard let expression = try? NSRegularExpression(pattern: pattern),
      let match = expression.firstMatch(
        in: value,
        range: NSRange(value.startIndex..., in: value)
      ),
      let majorRange = Range(match.range(at: 1), in: value),
      let minorRange = Range(match.range(at: 2), in: value),
      let patchRange = Range(match.range(at: 3), in: value),
      let major = Int(value[majorRange]),
      let minor = Int(value[minorRange]),
      let patch = Int(value[patchRange])
    else {
      return nil
    }
    self.major = major
    self.minor = minor
    self.patch = patch
    if let range = Range(match.range(at: 4), in: value) {
      prerelease = value[range].split(separator: ".").map(String.init)
    } else {
      prerelease = nil
    }
  }

  static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
    let lhsCore = [lhs.major, lhs.minor, lhs.patch]
    let rhsCore = [rhs.major, rhs.minor, rhs.patch]
    if lhsCore != rhsCore { return lhsCore.lexicographicallyPrecedes(rhsCore) }
    switch (lhs.prerelease, rhs.prerelease) {
    case (nil, nil): return false
    case (nil, _): return false
    case (_, nil): return true
    case (.some(let lhsIdentifiers), .some(let rhsIdentifiers)):
      for (lhsIdentifier, rhsIdentifier) in zip(lhsIdentifiers, rhsIdentifiers) {
        if lhsIdentifier == rhsIdentifier { continue }
        let lhsNumber = Int(lhsIdentifier)
        let rhsNumber = Int(rhsIdentifier)
        switch (lhsNumber, rhsNumber) {
        case (.some(let lhsNumber), .some(let rhsNumber)): return lhsNumber < rhsNumber
        case (.some, nil): return true
        case (nil, .some): return false
        case (nil, nil): return lhsIdentifier < rhsIdentifier
        }
      }
      return lhsIdentifiers.count < rhsIdentifiers.count
    }
  }
}
