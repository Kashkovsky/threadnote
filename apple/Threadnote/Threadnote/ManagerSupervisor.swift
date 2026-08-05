import Combine
import Foundation

@MainActor
final class ManagerSupervisor: ObservableObject {
  @Published private(set) var url: URL?
  @Published private(set) var errorMessage: String?

  private var process: Process?
  private var output = ""
  private var waiters: [CheckedContinuation<URL, Error>] = []
  private var timeoutTask: Task<Void, Never>?

  func start(command: ThreadnoteCommand) async throws -> URL {
    if let url, process?.isRunning == true { return url }
    if process?.isRunning == true {
      return try await waitForManagerURL()
    }

    let process = Process()
    let standardOutput = Pipe()
    let standardError = Pipe()
    process.executableURL = command.executable
    process.arguments = command.arguments(["manage", "--no-open"])
    process.environment = ProcessInfo.processInfo.environment.merging(command.environment) {
      _, new in new
    }
    process.standardOutput = standardOutput
    process.standardError = standardError
    self.process = process
    output = ""
    url = nil
    errorMessage = nil

    for handle in [standardOutput.fileHandleForReading, standardError.fileHandleForReading] {
      handle.readabilityHandler = { [weak self] handle in
        let data = handle.availableData
        guard !data.isEmpty else { return }
        let text = String(decoding: data, as: UTF8.self)
        Task { @MainActor [weak self] in self?.consume(text) }
      }
    }

    process.terminationHandler = { [weak self] process in
      standardOutput.fileHandleForReading.readabilityHandler = nil
      standardError.fileHandleForReading.readabilityHandler = nil
      Task { @MainActor [weak self] in
        self?.terminated(status: process.terminationStatus)
      }
    }

    do {
      try process.run()
    } catch {
      self.process = nil
      throw ManagerSupervisorError.launchFailed(error.localizedDescription)
    }

    timeoutTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(15))
      guard !Task.isCancelled else { return }
      self?.managerTimedOut()
    }
    return try await waitForManagerURL()
  }

  func stop() {
    timeoutTask?.cancel()
    timeoutTask = nil
    if process?.isRunning == true { process?.terminate() }
    process = nil
    url = nil
    resumeWaiters(with: .failure(CancellationError()))
  }

  private func consume(_ text: String) {
    output = String((output + text).suffix(16_384))
    guard url == nil, let managerURL = ManagerURLParser.parse(output) else { return }
    url = managerURL
    timeoutTask?.cancel()
    timeoutTask = nil
    resumeWaiters(with: .success(managerURL))
    output = ""
  }

  private func terminated(status: Int32) {
    process = nil
    url = nil
    let error = ManagerSupervisorError.terminated(status)
    errorMessage = error.localizedDescription
    resumeWaiters(with: .failure(error))
  }

  private func managerTimedOut() {
    let error = ManagerSupervisorError.timedOut
    errorMessage = error.localizedDescription
    process?.terminate()
    resumeWaiters(with: .failure(error))
    timeoutTask = nil
  }

  private func waitForManagerURL() async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      waiters.append(continuation)
    }
  }

  private func resumeWaiters(with result: Result<URL, Error>) {
    let pending = waiters
    waiters.removeAll()
    for waiter in pending { waiter.resume(with: result) }
  }
}

enum ManagerSupervisorError: LocalizedError {
  case launchFailed(String)
  case terminated(Int32)
  case timedOut

  var errorDescription: String? {
    switch self {
    case .launchFailed(let message): "Could not launch the Threadnote manager: \(message)"
    case .terminated(let status): "The Threadnote manager stopped with status \(status)."
    case .timedOut: "The Threadnote manager did not become ready within 15 seconds."
    }
  }
}
