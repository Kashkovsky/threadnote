import Foundation

struct MemoryFileState: Equatable, Sendable {
  let modifiedAt: Date
  let size: Int
}

enum MemorySnapshot {
  static func capture(at root: URL, fileManager: FileManager = .default) -> [String:
    MemoryFileState]
  {
    guard
      let enumerator = fileManager.enumerator(
        at: root,
        includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey],
        options: [.skipsHiddenFiles, .skipsPackageDescendants]
      )
    else { return [:] }

    var snapshot: [String: MemoryFileState] = [:]
    for case let fileURL as URL in enumerator {
      guard isMemoryFile(fileURL) else { continue }
      guard
        let values = try? fileURL.resourceValues(
          forKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        ), values.isRegularFile == true
      else { continue }
      snapshot[fileURL.path] = MemoryFileState(
        modifiedAt: values.contentModificationDate ?? .distantPast,
        size: values.fileSize ?? 0
      )
    }
    return snapshot
  }

  static func containsStoredMemory(
    previous: [String: MemoryFileState],
    current: [String: MemoryFileState]
  ) -> Bool {
    current.contains { path, state in previous[path] != state }
  }

  static func isMemoryFile(_ url: URL) -> Bool {
    let name = url.lastPathComponent
    return url.pathExtension.lowercased() == "md"
      && url.pathComponents.contains("memories")
      && name != ".abstract.md"
      && name != ".overview.md"
  }
}

@MainActor
final class MemoryActivityMonitor {
  private let root: URL
  private let interval: Duration
  private var task: Task<Void, Never>?

  init(root: URL, interval: Duration = .seconds(4)) {
    self.root = root
    self.interval = interval
  }

  func start(onMemoryStored: @escaping @MainActor @Sendable () -> Void) {
    guard task == nil else { return }
    task = Task { [root, interval] in
      var previous = await Task.detached(priority: .utility) {
        MemorySnapshot.capture(at: root)
      }.value
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: interval)
        } catch {
          break
        }
        let current = await Task.detached(priority: .utility) {
          MemorySnapshot.capture(at: root)
        }.value
        if MemorySnapshot.containsStoredMemory(previous: previous, current: current) {
          onMemoryStored()
        }
        previous = current
      }
    }
  }

  func stop() {
    task?.cancel()
    task = nil
  }
}
