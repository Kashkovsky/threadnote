import AppKit
import SwiftUI

@main
struct ThreadnoteApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var model = AppModel()

  var body: some Scene {
    MenuBarExtra {
      StatusMenu(model: model)
        .task { await model.bootstrap() }
    } label: {
      MenuBarLabel(model: model)
        .onAppear { appDelegate.manager = model.manager }
    }
    .menuBarExtraStyle(.window)

    Window("Threadnote Manager", id: "manager") {
      ManagerWindow(model: model)
    }
    .defaultSize(width: 1100, height: 760)

    Window("Threadnote Setup", id: "setup") {
      SetupView(model: model)
    }
    .windowResizability(.contentSize)

    Settings {
      ThreadnoteSettingsView(
        model: model,
        loginItem: model.loginItem,
        notifications: model.notifications
      )
    }
  }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
  weak var manager: ManagerSupervisor?

  func applicationWillTerminate(_ notification: Notification) {
    manager?.stop()
  }
}

private struct MenuBarLabel: View {
  @AppStorage("didCompleteOnboarding") private var didCompleteOnboarding = false
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var model: AppModel

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      ThreadnoteMark(size: 17)
      Circle()
        .fill(statusColor)
        .frame(width: 6, height: 6)
        .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 1))
        .offset(x: 2, y: 2)
    }
    .accessibilityLabel("Threadnote: \(model.status.title)")
    .task {
      await model.bootstrap()
      if !didCompleteOnboarding { openWindow(id: "setup") }
    }
  }

  private var statusColor: Color {
    switch model.status {
    case .checking: ThreadnoteStyle.amber
    case .healthy: ThreadnoteStyle.teal
    case .stopped: .secondary
    case .unavailable: ThreadnoteStyle.coral
    }
  }
}
