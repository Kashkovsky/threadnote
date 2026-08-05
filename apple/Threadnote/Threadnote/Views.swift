import AppKit
import SwiftUI
import UserNotifications

struct StatusMenu: View {
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var model: AppModel

  var body: some View {
    ZStack {
      ThreadnoteBackdrop()
      VStack(spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          ThreadnoteHeader(
            title: "Threadnote",
            subtitle: "Shared memory, close at hand",
            compact: true
          )
          StatusPill(
            title: model.status.title,
            systemImage: model.status.systemImage,
            color: model.status.tint
          )
        }

        ActivityFeedback(model: model)

        ThreadnoteCard {
          VStack(spacing: 13) {
            MenuActionRow(
              title: "Open Manager",
              detail: "Browse and edit shared memories",
              systemImage: "rectangle.stack.fill"
            ) {
              openWindow(id: "manager")
              Task { await model.startManager() }
            }
            Divider()
            MenuActionRow(
              title: "Agent Integrations",
              detail: "Install, reinstall, or remove MCP access",
              systemImage: "point.3.connected.trianglepath.dotted",
              tint: ThreadnoteStyle.coral
            ) { openWindow(id: "setup") }
          }
        }

        ThreadnoteCard {
          VStack(spacing: 12) {
            HStack {
              Text("LOCAL MEMORY SERVICE")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
              Spacer()
              Text(model.status.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(model.status.tint)
            }
            HStack(spacing: 8) {
              ServiceButton(title: "Start", systemImage: "play.fill", tint: ThreadnoteStyle.teal) {
                Task { await model.start() }
              }
              ServiceButton(title: "Stop", systemImage: "stop.fill", tint: ThreadnoteStyle.coral) {
                Task { await model.stop() }
              }
              ServiceButton(
                title: "Diagnose", systemImage: "stethoscope", tint: ThreadnoteStyle.amber
              ) {
                Task { await model.doctor() }
              }
            }
            .disabled(model.isBusy || model.command == nil)
          }
        }

        ThreadnoteCard {
          VStack(spacing: 13) {
            MenuActionRow(
              title: "Refresh Status",
              detail: model.refreshDescription,
              systemImage: "arrow.clockwise"
            ) { Task { await model.refresh() } }
            .disabled(model.isBusy)
            Divider()
            MenuActionRow(
              title: "Open Logs",
              detail: "Inspect the OpenViking service log",
              systemImage: "doc.text.magnifyingglass",
              tint: .secondary
            ) { model.openLogs() }
          }
        }

        HStack {
          SettingsControl()
          Spacer()
          Button("Quit") {
            model.shutdown()
            NSApplication.shared.terminate(nil)
          }
          .buttonStyle(.plain)
          .foregroundStyle(.secondary)
        }
        .font(.callout)
        .padding(.horizontal, 4)
      }
      .padding(16)
    }
    .frame(width: 370)
  }
}

private struct SettingsControl: View {
  var body: some View {
    if #available(macOS 14.0, *) {
      SettingsLink {
        Label("Settings", systemImage: "gearshape")
      }
      .buttonStyle(.plain)
    } else {
      Button {
        NSApplication.shared.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
      } label: {
        Label("Settings", systemImage: "gearshape")
      }
      .buttonStyle(.plain)
    }
  }
}

private struct ServiceButton: View {
  let title: String
  let systemImage: String
  let tint: Color
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(title, systemImage: systemImage)
        .font(.caption.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .foregroundStyle(tint)
        .background(tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
    }
    .buttonStyle(.plain)
  }
}

private struct ActivityFeedback: View {
  @ObservedObject var model: AppModel

  var body: some View {
    if let operation = model.operation {
      HStack(spacing: 9) {
        ProgressView().controlSize(.small)
        Text(operation.rawValue).font(.callout.weight(.medium))
        Spacer()
        Button("Cancel") { model.cancelOperation() }
          .controlSize(.small)
      }
      .padding(11)
      .background(ThreadnoteStyle.teal.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    } else if let error = model.errorMessage {
      FeedbackBanner(message: error, successful: false)
    } else if let feedback = model.feedback {
      FeedbackBanner(message: feedback.message, successful: feedback.successful)
    }
  }
}

private struct FeedbackBanner: View {
  let message: String
  let successful: Bool

  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: successful ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
        .foregroundStyle(successful ? ThreadnoteStyle.teal : ThreadnoteStyle.coral)
      Text(message)
        .font(.callout)
        .lineLimit(2)
      Spacer()
    }
    .padding(11)
    .background(
      (successful ? ThreadnoteStyle.teal : ThreadnoteStyle.coral).opacity(0.1),
      in: RoundedRectangle(cornerRadius: 12)
    )
  }
}

struct ManagerWindow: View {
  @ObservedObject var model: AppModel
  @ObservedObject private var manager: ManagerSupervisor
  @State private var loadError: String?
  @State private var isLoading = true
  @State private var loadAttempt = UUID()

  init(model: AppModel) {
    self.model = model
    manager = model.manager
  }

  var body: some View {
    Group {
      if let url = manager.url {
        ZStack {
          ManagerWebView(url: url, loadError: $loadError, isLoading: $isLoading)
            .id(loadAttempt)
          if let loadError {
            VStack(spacing: 14) {
              Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 36))
                .foregroundStyle(.orange)
              Text("Manager unavailable").font(.title2.bold())
              Text(loadError)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
              Button("Reload") {
                self.loadError = nil
                isLoading = true
                loadAttempt = UUID()
              }
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.background)
          } else if isLoading {
            VStack(spacing: 14) {
              ProgressView()
              Text("Loading Threadnote Manager…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.background)
          }
        }
      } else {
        VStack(spacing: 14) {
          Image(systemName: "rectangle.on.rectangle.slash")
            .font(.system(size: 36))
            .foregroundStyle(.secondary)
          Text("Manager is not running").font(.title2.bold())
          Text(
            manager.errorMessage ?? model.errorMessage
              ?? "Start the local manager to browse and edit Threadnote memory."
          )
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
          Button("Start Manager") { Task { await model.startManager() } }
            .disabled(model.command == nil)
        }
        .padding(32)
      }
    }
    .frame(minWidth: 900, minHeight: 620)
    .task { await model.startManager() }
  }
}

struct SetupView: View {
  @AppStorage("didCompleteOnboarding") private var didCompleteOnboarding = false
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var model: AppModel
  @State private var selectedAgent: AgentClient = .codex
  @State private var showIntegrationConfirmation = false
  @State private var showRemovalConfirmation = false

  private var selectedStatus: AgentIntegrationStatus? {
    model.integrationStatus(for: selectedAgent)
  }

  private var canConfigureSelectedAgent: Bool {
    guard let selectedStatus else { return false }
    return selectedStatus.available || selectedAgent == .cursor || selectedAgent == .copilot
  }

  var body: some View {
    ZStack {
      ThreadnoteBackdrop()
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ThreadnoteHeader(
            title: "Connect Threadnote",
            subtitle: "Keep local memory available to every coding agent you choose"
          )

          ThreadnoteCard {
            VStack(alignment: .leading, spacing: 14) {
              Text("FOUNDATION").font(.caption2.bold()).foregroundStyle(.secondary)
              SetupRow(
                title: "Threadnote runtime",
                detail: model.runtimeDescription,
                systemImage: model.command == nil ? "xmark.circle" : "checkmark.circle.fill",
                color: model.command == nil ? ThreadnoteStyle.coral : ThreadnoteStyle.teal
              )
              Divider()
              SetupRow(
                title: "OpenViking service",
                detail: model.status.title,
                systemImage: model.status.systemImage,
                color: model.status.tint
              )
              if model.command == nil {
                Text(
                  "No Threadnote runtime was found. Release builds must include the private app runtime."
                )
                .font(.callout)
                .foregroundStyle(.secondary)
              }
              HStack {
                Button("Install or Repair Dependencies") {
                  Task { await model.installDependencies() }
                }
                Button("Run Diagnostics") { Task { await model.doctor() } }
              }
              .disabled(model.isBusy || model.command == nil)
            }
          }

          ThreadnoteCard {
            VStack(alignment: .leading, spacing: 14) {
              HStack {
                VStack(alignment: .leading, spacing: 2) {
                  Text("AGENT INTEGRATION").font(.caption2.bold()).foregroundStyle(.secondary)
                  Text("Choose exactly where Threadnote appears").font(.headline)
                }
                Spacer()
                if let selectedStatus {
                  StatusPill(
                    title: selectedStatus.installed ? "Installed" : "Not installed",
                    systemImage: selectedStatus.installed
                      ? "checkmark.circle.fill" : "minus.circle",
                    color: selectedStatus.installed ? ThreadnoteStyle.teal : .secondary
                  )
                } else {
                  ProgressView().controlSize(.small)
                }
              }

              Picker("Agent", selection: $selectedAgent) {
                ForEach(AgentClient.allCases) { agent in Text(agent.label).tag(agent) }
              }
              .pickerStyle(.segmented)

              HStack(alignment: .top, spacing: 12) {
                Image(
                  systemName: selectedStatus?.installed == true ? "link.circle.fill" : "link.circle"
                )
                .font(.title2)
                .foregroundStyle(
                  selectedStatus?.installed == true ? ThreadnoteStyle.teal : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                  Text(selectedAgent.label).font(.headline)
                  Text(
                    selectedStatus?.detail ?? model.integrationStatusError
                      ?? "Checking integration…"
                  )
                  .font(.callout)
                  .foregroundStyle(.secondary)
                }
                Spacer()
              }

              HStack {
                Button("Preview Changes") {
                  Task { await model.previewIntegration(selectedAgent) }
                }
                .disabled(model.isBusy || model.command == nil || !canConfigureSelectedAgent)
                Spacer()
                if selectedStatus?.installed == true {
                  Button("Remove", role: .destructive) { showRemovalConfirmation = true }
                    .disabled(model.isBusy)
                  Button("Reinstall") { showIntegrationConfirmation = true }
                    .buttonStyle(.borderedProminent)
                    .tint(ThreadnoteStyle.teal)
                    .disabled(model.isBusy || !canConfigureSelectedAgent)
                } else {
                  Button("Install") { showIntegrationConfirmation = true }
                    .buttonStyle(.borderedProminent)
                    .tint(ThreadnoteStyle.teal)
                    .disabled(model.isBusy || model.command == nil || !canConfigureSelectedAgent)
                }
              }
            }
          }

          OperationOutput(model: model)

          HStack {
            Button("Open Manager") {
              openWindow(id: "manager")
              Task { await model.startManager() }
            }
            Spacer()
            Button("Finish") {
              didCompleteOnboarding = true
              dismiss()
            }
            .buttonStyle(.borderedProminent)
            .tint(ThreadnoteStyle.teal)
            .disabled(model.command == nil)
          }
        }
        .padding(28)
      }
    }
    .frame(width: 720, height: 700)
    .task { await model.bootstrap() }
    .confirmationDialog(
      "\(selectedStatus?.installed == true ? "Reinstall" : "Install") Threadnote for \(selectedAgent.label)?",
      isPresented: $showIntegrationConfirmation
    ) {
      Button(selectedStatus?.installed == true ? "Reinstall" : "Install") {
        Task { await model.installIntegration(selectedAgent) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Threadnote will update the user-level MCP configuration after preserving unmanaged settings where supported."
      )
    }
    .confirmationDialog(
      "Remove Threadnote from \(selectedAgent.label)?",
      isPresented: $showRemovalConfirmation
    ) {
      Button("Remove Integration", role: .destructive) {
        Task { await model.removeIntegration(selectedAgent) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Only Threadnote's MCP entry for \(selectedAgent.label) will be removed.")
    }
  }
}

struct ThreadnoteSettingsView: View {
  @ObservedObject var model: AppModel
  @ObservedObject var loginItem: LoginItemController
  @ObservedObject var notifications: NotificationController
  @AppStorage(NotificationPreference.enabled) private var notificationsEnabled = false
  @AppStorage(NotificationPreference.memory) private var memoryNotifications = true
  @AppStorage(NotificationPreference.diagnostics) private var diagnosticNotifications = true
  @AppStorage(NotificationPreference.service) private var serviceNotifications = true
  @AppStorage(NotificationPreference.integrations) private var integrationNotifications = true
  @State private var showRepairConfirmation = false

  var body: some View {
    ZStack {
      ThreadnoteBackdrop()
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          ThreadnoteHeader(
            title: "Threadnote Settings",
            subtitle: "Tune the quiet background helper to your workflow"
          )

          ThreadnoteCard {
            VStack(alignment: .leading, spacing: 13) {
              Text("GENERAL").font(.caption2.bold()).foregroundStyle(.secondary)
              Toggle(
                "Launch Threadnote at login",
                isOn: Binding(
                  get: { loginItem.enabled },
                  set: { loginItem.setEnabled($0) }
                )
              )
              if loginItem.requiresApproval {
                HStack {
                  Text("Approval is required in System Settings.")
                    .foregroundStyle(ThreadnoteStyle.amber)
                  Spacer()
                  Button("Open Login Items") { loginItem.openSystemSettings() }
                }
              }
              if let error = loginItem.errorMessage {
                Text(error).foregroundStyle(ThreadnoteStyle.coral)
              }
            }
          }

          ThreadnoteCard {
            VStack(alignment: .leading, spacing: 13) {
              Text("NOTIFICATIONS").font(.caption2.bold()).foregroundStyle(.secondary)
              Toggle("Enable Threadnote notifications", isOn: notificationToggle)
                .font(.headline)
              Text(notifications.authorizationDescription)
                .font(.callout)
                .foregroundStyle(.secondary)
              if notifications.authorizationStatus == .denied {
                Button("Open Notification Settings") { notifications.openSystemSettings() }
              }
              Divider()
              Group {
                NotificationToggle(
                  title: "Memory saved",
                  detail: "A generic notice when a memory file is stored",
                  isOn: $memoryNotifications
                )
                NotificationToggle(
                  title: "Diagnostics",
                  detail: "Completion and attention-required results",
                  isOn: $diagnosticNotifications
                )
                NotificationToggle(
                  title: "Service status",
                  detail: "OpenViking starts, stops, or needs attention",
                  isOn: $serviceNotifications
                )
                NotificationToggle(
                  title: "Agent integrations",
                  detail: "An integration is installed, removed, or changed",
                  isOn: $integrationNotifications
                )
              }
              .disabled(!notificationsEnabled)
            }
          }

          ThreadnoteCard {
            VStack(alignment: .leading, spacing: 13) {
              Text("RUNTIME").font(.caption2.bold()).foregroundStyle(.secondary)
              LabeledContent("Runtime", value: model.runtimeDescription)
              LabeledContent("Service", value: model.status.title)
              if model.hasLegacyLaunchAgent {
                Label(
                  "Legacy io.threadnote.openviking LaunchAgent detected. Threadnote will avoid starting a second service.",
                  systemImage: "exclamationmark.triangle"
                )
                .foregroundStyle(ThreadnoteStyle.amber)
              }
              HStack {
                Button("Reveal App Data") { model.revealApplicationSupport() }
                Button("Check for Updates") { Task { await model.checkForUpdates() } }
                  .disabled(model.isBusy || model.command == nil)
              }
            }
          }

          ThreadnoteCard {
            VStack(alignment: .leading, spacing: 13) {
              Text("MAINTENANCE").font(.caption2.bold()).foregroundStyle(.secondary)
              HStack {
                Button("Preview Repair") { Task { await model.previewRepair() } }
                  .disabled(model.isBusy || model.command == nil)
                Button("Apply Repair") { showRepairConfirmation = true }
                  .disabled(model.isBusy || model.command == nil)
              }
              OperationOutput(model: model)
            }
          }
        }
        .padding(28)
      }
    }
    .frame(width: 700, height: 680)
    .task { await model.bootstrap() }
    .confirmationDialog("Apply Threadnote repair?", isPresented: $showRepairConfirmation) {
      Button("Repair") { Task { await model.repair() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Repair may update Threadnote-managed configuration and service files. Memories are preserved."
      )
    }
  }

  private var notificationToggle: Binding<Bool> {
    Binding(
      get: { notificationsEnabled },
      set: { enabled in
        notificationsEnabled = enabled
        if enabled { Task { await notifications.enable() } }
      }
    )
  }
}

private struct NotificationToggle: View {
  let title: String
  let detail: String
  @Binding var isOn: Bool

  var body: some View {
    Toggle(isOn: $isOn) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
        Text(detail).font(.caption).foregroundStyle(.secondary)
      }
    }
  }
}

private struct SetupRow: View {
  let title: String
  let detail: String
  let systemImage: String
  let color: Color

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: systemImage).foregroundStyle(color)
      VStack(alignment: .leading) {
        Text(title).font(.headline)
        Text(detail).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
      }
    }
  }
}

private struct OperationOutput: View {
  @ObservedObject var model: AppModel

  var body: some View {
    if let operation = model.operation {
      HStack {
        ProgressView().controlSize(.small)
        Text(operation.rawValue)
        Spacer()
        Button("Cancel") { model.cancelOperation() }
          .controlSize(.small)
      }
    }
    if let error = model.errorMessage {
      Text(error)
        .font(.callout)
        .foregroundStyle(.red)
        .textSelection(.enabled)
    }
    if !model.output.isEmpty {
      ScrollView {
        Text(model.output)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(minHeight: 100, maxHeight: 180)
      .padding(8)
      .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
  }
}

extension ServiceStatus {
  fileprivate var tint: Color {
    switch self {
    case .checking: ThreadnoteStyle.amber
    case .healthy: ThreadnoteStyle.teal
    case .stopped: .secondary
    case .unavailable: ThreadnoteStyle.coral
    }
  }
}
