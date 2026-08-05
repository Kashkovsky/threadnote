import Darwin
import Foundation

@main
enum ThreadnoteLauncher {
  static func main() {
    let invokedURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let supportURL = invokedURL.deletingLastPathComponent().deletingLastPathComponent()
    let runtimeURL = supportURL.appendingPathComponent("runtime/current", isDirectory: true)
    let nodeURL = runtimeURL.appendingPathComponent("bin/node")
    let isMCP = invokedURL.lastPathComponent.contains("mcp")
    let entryName = isMCP ? "threadnote-mcp-server.cjs" : "threadnote.cjs"
    let entryURL = runtimeURL.appendingPathComponent("threadnote/bin/\(entryName)")

    guard FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
      fail("Threadnote's private Node runtime is missing. Reopen Threadnote.app to repair it.")
    }
    guard FileManager.default.fileExists(atPath: entryURL.path) else {
      fail("Threadnote's app-managed core is missing. Reopen Threadnote.app to repair it.")
    }

    let existingPath =
      ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    let path = [
      supportURL.appendingPathComponent("bin").path,
      runtimeURL.appendingPathComponent("bin").path,
      FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      existingPath,
    ].joined(separator: ":")
    setenv("PATH", path, 1)
    setenv("THREADNOTE_APP_MANAGED", "1", 1)
    setenv("THREADNOTE_BIN_DIR", supportURL.appendingPathComponent("bin").path, 1)
    setenv(
      "THREADNOTE_MCP_ADAPTER_COMMAND",
      supportURL.appendingPathComponent("bin/threadnote-mcp-server").path, 1)
    setenv("THREADNOTE_CALLER_CWD", FileManager.default.currentDirectoryPath, 1)

    let arguments = [nodeURL.path, entryURL.path] + CommandLine.arguments.dropFirst()
    let cArguments: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
    defer {
      for pointer in cArguments.dropLast() { free(pointer) }
    }
    _ = cArguments.withUnsafeBufferPointer { buffer in
      execv(nodeURL.path, buffer.baseAddress!)
    }
    fail("Could not launch Threadnote: \(String(cString: strerror(errno)))")
  }

  private static func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(127)
  }
}
