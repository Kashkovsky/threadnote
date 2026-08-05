import Foundation

struct CommandResult: Sendable {
  let exitCode: Int32
  let output: String
}

enum CommandRunnerError: LocalizedError {
  case failedToLaunch(String)
  case nonZeroExit(Int32, String)
  case timedOut(TimeInterval)

  var errorDescription: String? {
    switch self {
    case .failedToLaunch(let message): message
    case .nonZeroExit(let code, let output):
      output.isEmpty ? "Threadnote exited with status \(code)." : output
    case .timedOut(let seconds): "The operation timed out after \(Int(seconds)) seconds."
    }
  }
}

final class ProcessRunner: @unchecked Sendable {
  private let lock = NSLock()
  private var runningProcess: RunningProcess?

  func run(
    command: ThreadnoteCommand,
    arguments: [String],
    timeout: TimeInterval,
    onOutput: (@Sendable (String) -> Void)? = nil
  ) async throws -> CommandResult {
    let running = RunningProcess(
      executable: command.executable,
      arguments: command.arguments(arguments),
      environment: command.environment,
      timeout: timeout,
      onOutput: onOutput
    )
    lock.withLock { runningProcess = running }
    defer {
      lock.withLock {
        if runningProcess === running { runningProcess = nil }
      }
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        running.start { result in continuation.resume(with: result) }
      }
    } onCancel: {
      running.cancel()
    }
  }

  func cancelCurrent() {
    lock.withLock { runningProcess }?.cancel()
  }
}

private final class RunningProcess: @unchecked Sendable {
  private let executable: URL
  private let arguments: [String]
  private let environment: [String: String]
  private let timeout: TimeInterval
  private let onOutput: (@Sendable (String) -> Void)?
  private let lock = NSLock()
  private let output = OutputAccumulator()
  private var process: Process?
  private var completion: ((Result<CommandResult, Error>) -> Void)?
  private var completed = false
  private var timeoutWorkItem: DispatchWorkItem?

  init(
    executable: URL,
    arguments: [String],
    environment: [String: String],
    timeout: TimeInterval,
    onOutput: (@Sendable (String) -> Void)?
  ) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.timeout = timeout
    self.onOutput = onOutput
  }

  func start(completion: @escaping (Result<CommandResult, Error>) -> Void) {
    let process = Process()
    let standardOutput = Pipe()
    let standardError = Pipe()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
    process.standardOutput = standardOutput
    process.standardError = standardError
    self.completion = completion
    self.process = process

    for handle in [standardOutput.fileHandleForReading, standardError.fileHandleForReading] {
      handle.readabilityHandler = { [weak self] handle in
        let data = handle.availableData
        guard !data.isEmpty else { return }
        self?.output.append(data)
        if let text = String(data: data, encoding: .utf8) {
          self?.onOutput?(text)
        }
      }
    }

    process.terminationHandler = { [weak self] process in
      standardOutput.fileHandleForReading.readabilityHandler = nil
      standardError.fileHandleForReading.readabilityHandler = nil
      self?.output.append(standardOutput.fileHandleForReading.readDataToEndOfFile())
      self?.output.append(standardError.fileHandleForReading.readDataToEndOfFile())
      let captured = self?.output.string ?? ""
      if process.terminationStatus == 0 {
        self?.finish(.success(CommandResult(exitCode: 0, output: captured)))
      } else {
        self?.finish(.failure(CommandRunnerError.nonZeroExit(process.terminationStatus, captured)))
      }
    }

    do {
      try process.run()
    } catch {
      finish(.failure(CommandRunnerError.failedToLaunch(error.localizedDescription)))
      return
    }

    let timeoutWorkItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.process?.terminate()
      self.finish(.failure(CommandRunnerError.timedOut(self.timeout)))
    }
    self.timeoutWorkItem = timeoutWorkItem
    DispatchQueue.global(qos: .utility).asyncAfter(
      deadline: .now() + timeout, execute: timeoutWorkItem)
  }

  func cancel() {
    lock.withLock { process?.terminate() }
  }

  private func finish(_ result: Result<CommandResult, Error>) {
    let callback: ((Result<CommandResult, Error>) -> Void)? = lock.withLock {
      guard !completed else { return nil }
      completed = true
      timeoutWorkItem?.cancel()
      let callback = completion
      completion = nil
      return callback
    }
    callback?(result)
  }
}

private final class OutputAccumulator: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()
  private let limit = 2 * 1_024 * 1_024

  func append(_ next: Data) {
    guard !next.isEmpty else { return }
    lock.withLock {
      data.append(next)
      if data.count > limit {
        data.removeFirst(data.count - limit)
      }
    }
  }

  var string: String {
    lock.withLock { String(decoding: data, as: UTF8.self) }
  }
}

extension NSLock {
  fileprivate func withLock<T>(_ operation: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try operation()
  }
}
