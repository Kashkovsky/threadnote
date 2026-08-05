import AppKit
import Combine
import Foundation

enum AppOperation: String, Sendable {
  case checking = "Checking Threadnote"
  case refreshing = "Refreshing status"
  case starting = "Starting OpenViking"
  case stopping = "Stopping OpenViking"
  case doctor = "Running diagnostics"
  case repairPreview = "Previewing repair"
  case repairing = "Repairing Threadnote"
  case installing = "Installing dependencies"
  case integrationPreview = "Previewing agent integration"
  case integrationApply = "Installing agent integration"
  case integrationRemove = "Removing agent integration"
  case updateCheck = "Checking for updates"

  var completionMessage: String {
    switch self {
    case .checking, .refreshing: "Status refreshed"
    case .starting: "OpenViking started"
    case .stopping: "OpenViking stopped"
    case .doctor: "Diagnostics complete"
    case .repairPreview: "Repair preview complete"
    case .repairing: "Threadnote repair complete"
    case .installing: "Dependencies installed"
    case .integrationPreview: "Integration preview ready"
    case .integrationApply: "Agent integration installed"
    case .integrationRemove: "Agent integration removed"
    case .updateCheck: "Update check complete"
    }
  }
}

enum AgentClient: String, CaseIterable, Codable, Identifiable, Sendable {
  case codex
  case claude
  case cursor
  case copilot

  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

struct AppFeedback: Equatable, Sendable {
  let message: String
  let successful: Bool
  let date: Date
}

@MainActor
final class AppModel: ObservableObject {
  @Published private(set) var status: ServiceStatus = .checking
  @Published private(set) var operation: AppOperation?
  @Published private(set) var command: ThreadnoteCommand?
  @Published private(set) var output = ""
  @Published private(set) var errorMessage: String?
  @Published private(set) var runtimeInstalled = false
  @Published private(set) var integrationStatuses: [AgentClient: AgentIntegrationStatus] = [:]
  @Published private(set) var integrationStatusError: String?
  @Published private(set) var feedback: AppFeedback?
  @Published private(set) var lastRefreshedAt: Date?

  let loginItem = LoginItemController()
  let manager = ManagerSupervisor()
  let notifications: NotificationController
  let paths: ThreadnotePaths

  private let processRunner: ProcessRunner
  private let statusRunner: ProcessRunner
  private let healthClient: HealthClient
  private let memoryMonitor: MemoryActivityMonitor
  private var locator: ThreadnoteCommandLocator
  private var didBootstrap = false
  private var didObserveHealth = false
  private var healthMonitorTask: Task<Void, Never>?

  init(
    paths: ThreadnotePaths = ThreadnotePaths(),
    processRunner: ProcessRunner = ProcessRunner(),
    healthClient: HealthClient = HealthClient()
  ) {
    self.paths = paths
    self.processRunner = processRunner
    statusRunner = ProcessRunner()
    self.healthClient = healthClient
    notifications = NotificationController()
    memoryMonitor = MemoryActivityMonitor(root: paths.openVikingUserDataURL)
    locator = ThreadnoteCommandLocator(paths: paths)
  }

  var isBusy: Bool { operation != nil }
  var hasLegacyLaunchAgent: Bool {
    FileManager.default.fileExists(atPath: paths.legacyLaunchAgentURL.path)
  }
  var runtimeDescription: String {
    guard let command else { return "No Threadnote runtime found" }
    if command.executable.path.hasPrefix(paths.applicationSupportURL.path) {
      return "App-managed runtime"
    }
    return command.executable.path
  }
  var refreshDescription: String {
    guard let lastRefreshedAt else {
      return "Service, runtime, login item, and agent integrations"
    }
    return "Last checked \(lastRefreshedAt.formatted(date: .omitted, time: .shortened))"
  }

  func integrationStatus(for agent: AgentClient) -> AgentIntegrationStatus? {
    integrationStatuses[agent]
  }

  func bootstrap() async {
    guard !didBootstrap else { return }
    didBootstrap = true
    operation = .checking
    defer { operation = nil }
    do {
      if let bundled = locator.bundledRuntimeURL() {
        _ = try RuntimeInstaller(applicationSupportURL: paths.applicationSupportURL).install(
          bundledRuntime: bundled)
        runtimeInstalled = true
      }
      command = locator.locate()
      await refreshHealth()
      await refreshIntegrationStatuses(notifyChanges: false)
    } catch {
      errorMessage = error.localizedDescription
      command = locator.locate()
      status = .unavailable(error.localizedDescription)
    }
    loginItem.refresh()
    lastRefreshedAt = Date()
    memoryMonitor.start { [weak self] in self?.memoryWasStored() }
    startHealthMonitoring()
  }

  func refresh() async {
    guard operation == nil else { return }
    operation = .refreshing
    defer { operation = nil }
    errorMessage = nil
    command = locator.locate()
    await refreshHealth()
    await refreshIntegrationStatuses(notifyChanges: true)
    loginItem.refresh()
    lastRefreshedAt = Date()
    feedback = AppFeedback(
      message: AppOperation.refreshing.completionMessage, successful: true, date: Date())
  }

  func start() async {
    await run(.starting, arguments: ["start"], timeout: 90)
    await refreshHealth()
  }

  func stop() async {
    await run(.stopping, arguments: ["stop"], timeout: 30)
    await refreshHealth()
  }

  func doctor() async {
    let succeeded = await run(.doctor, arguments: ["doctor", "--dry-run"], timeout: 120)
    await refreshHealth()
    notifications.post(
      .diagnostics,
      title: succeeded ? "Diagnostics complete" : "Diagnostics need attention",
      body: succeeded
        ? "Threadnote finished checking the local runtime and service."
        : "Open Threadnote to review the diagnostic result."
    )
  }

  func previewRepair() async {
    await run(.repairPreview, arguments: ["repair", "--dry-run"], timeout: 180)
  }

  func repair() async {
    await run(.repairing, arguments: ["repair"], timeout: 1_200)
    await refreshHealth()
  }

  func installDependencies() async {
    guard hasInstallationDiskSpace else {
      errorMessage =
        "Threadnote needs at least 1.5 GB of available disk space to install OpenViking and its local embedding dependencies."
      return
    }
    await run(.installing, arguments: ["install", "--package-manager", "uv"], timeout: 1_800)
    await refreshHealth()
  }

  func previewIntegration(_ agent: AgentClient) async {
    await run(.integrationPreview, arguments: ["mcp-install", agent.rawValue], timeout: 120)
  }

  func installIntegration(_ agent: AgentClient) async {
    let succeeded = await run(
      .integrationApply, arguments: ["mcp-install", agent.rawValue, "--apply"], timeout: 180)
    await refreshIntegrationStatuses(notifyChanges: false)
    if succeeded {
      notifications.post(
        .integration,
        title: "\(agent.label) integration ready",
        body: "Threadnote is available to \(agent.label) through MCP."
      )
    }
  }

  func removeIntegration(_ agent: AgentClient) async {
    let succeeded = await run(
      .integrationRemove,
      arguments: ["mcp-install", agent.rawValue, "--remove", "--apply"],
      timeout: 180
    )
    await refreshIntegrationStatuses(notifyChanges: false)
    if succeeded {
      notifications.post(
        .integration,
        title: "\(agent.label) integration removed",
        body: "Threadnote no longer appears in \(agent.label)'s MCP configuration."
      )
    }
  }

  func checkForUpdates() async {
    await run(.updateCheck, arguments: ["update", "--check"], timeout: 30)
  }

  func startManager() async {
    errorMessage = nil
    guard let command else {
      errorMessage = "Install the Threadnote runtime before opening the manager."
      return
    }
    do {
      _ = try await manager.start(command: command)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func openLogs() {
    guard FileManager.default.fileExists(atPath: paths.openVikingLogURL.path) else {
      errorMessage = "No OpenViking log exists yet at \(paths.openVikingLogURL.path)."
      return
    }
    NSWorkspace.shared.open(paths.openVikingLogURL)
  }

  func revealApplicationSupport() {
    try? FileManager.default.createDirectory(
      at: paths.applicationSupportURL, withIntermediateDirectories: true)
    NSWorkspace.shared.activateFileViewerSelecting([paths.applicationSupportURL])
  }

  func clearMessages() {
    output = ""
    errorMessage = nil
  }

  func cancelOperation() {
    processRunner.cancelCurrent()
    statusRunner.cancelCurrent()
  }

  func shutdown() {
    healthMonitorTask?.cancel()
    healthMonitorTask = nil
    memoryMonitor.stop()
    manager.stop()
  }

  private func refreshHealth() async {
    let nextStatus: ServiceStatus
    if command == nil {
      nextStatus = .unavailable("Threadnote runtime not found")
    } else {
      nextStatus = await healthClient.check()
    }
    let previousStatus = status
    status = nextStatus
    if didObserveHealth, previousStatus != nextStatus {
      notifications.post(
        .service,
        title: "OpenViking status changed",
        body: "The local memory service is now \(nextStatus.title.lowercased())."
      )
    }
    didObserveHealth = true
  }

  @discardableResult
  private func run(_ nextOperation: AppOperation, arguments: [String], timeout: TimeInterval) async
    -> Bool
  {
    guard operation == nil else { return false }
    guard let command else {
      errorMessage = "Threadnote runtime not found. Use Setup to install or adopt a runtime."
      status = .unavailable("Threadnote runtime not found")
      feedback = AppFeedback(message: nextOperation.rawValue, successful: false, date: Date())
      return false
    }
    operation = nextOperation
    output = ""
    errorMessage = nil
    defer { operation = nil }
    let outputRelay = OutputRelay { [weak self] chunk in
      self?.appendOutput(chunk)
    }
    do {
      let result = try await processRunner.run(
        command: command,
        arguments: arguments,
        timeout: timeout
      ) { chunk in
        outputRelay.receive(chunk)
      }
      output = result.output
      feedback = AppFeedback(
        message: nextOperation.completionMessage,
        successful: true,
        date: Date()
      )
      return true
    } catch {
      errorMessage = error.localizedDescription
      feedback = AppFeedback(
        message: "\(nextOperation.rawValue) failed",
        successful: false,
        date: Date()
      )
      return false
    }
  }

  private func refreshIntegrationStatuses(notifyChanges: Bool) async {
    guard let command else {
      integrationStatuses = [:]
      integrationStatusError = "Threadnote runtime not found"
      return
    }
    do {
      let result = try await statusRunner.run(
        command: command,
        arguments: ["mcp-status"],
        timeout: 30
      )
      let statuses = try IntegrationStatusParser.parse(result.output)
      let previous = integrationStatuses
      integrationStatuses = Dictionary(uniqueKeysWithValues: statuses.map { ($0.agent, $0) })
      integrationStatusError = nil
      if notifyChanges, !previous.isEmpty {
        for status in statuses where previous[status.agent]?.installed != status.installed {
          notifications.post(
            .integration,
            title: "\(status.agent.label) integration changed",
            body: status.installed
              ? "Threadnote is now available to \(status.agent.label)."
              : "Threadnote was removed from \(status.agent.label)."
          )
        }
      }
    } catch {
      integrationStatusError = error.localizedDescription
    }
  }

  private func memoryWasStored() {
    feedback = AppFeedback(message: "Memory activity detected", successful: true, date: Date())
    notifications.post(
      .memory,
      title: "Memory saved",
      body: "A Threadnote memory was stored for your agents."
    )
  }

  private func startHealthMonitoring() {
    guard healthMonitorTask == nil else { return }
    healthMonitorTask = Task { [weak self] in
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(30))
        } catch {
          break
        }
        await self?.refreshHealth()
      }
    }
  }

  private func appendOutput(_ chunk: String) {
    output = String((output + chunk).suffix(2 * 1_024 * 1_024))
  }

  private var hasInstallationDiskSpace: Bool {
    let values = try? paths.applicationSupportURL.deletingLastPathComponent().resourceValues(
      forKeys: [.volumeAvailableCapacityForImportantUsageKey]
    )
    guard let capacity = values?.volumeAvailableCapacityForImportantUsage else { return true }
    return capacity >= 1_500_000_000
  }
}

private final class OutputRelay: @unchecked Sendable {
  private let handler: @MainActor @Sendable (String) -> Void

  init(handler: @escaping @MainActor @Sendable (String) -> Void) {
    self.handler = handler
  }

  func receive(_ chunk: String) {
    Task { @MainActor in handler(chunk) }
  }
}
