import AppKit
import Combine
import Foundation
import UserNotifications

enum NotificationPreference {
  static let enabled = "notifications.enabled"
  static let memory = "notifications.memory"
  static let diagnostics = "notifications.diagnostics"
  static let service = "notifications.service"
  static let integrations = "notifications.integrations"

  static func registerDefaults() {
    UserDefaults.standard.register(defaults: [
      enabled: false,
      memory: true,
      diagnostics: true,
      service: true,
      integrations: true,
    ])
  }
}

enum ThreadnoteNotificationKind {
  case memory
  case diagnostics
  case service
  case integration

  var preferenceKey: String {
    switch self {
    case .memory: NotificationPreference.memory
    case .diagnostics: NotificationPreference.diagnostics
    case .service: NotificationPreference.service
    case .integration: NotificationPreference.integrations
    }
  }
}

@MainActor
final class NotificationController: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
  @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined

  private let center = UNUserNotificationCenter.current()

  override init() {
    NotificationPreference.registerDefaults()
    super.init()
    center.delegate = self
    Task { await refreshAuthorizationStatus() }
  }

  var authorizationDescription: String {
    switch authorizationStatus {
    case .notDetermined: "Permission will be requested when notifications are enabled."
    case .denied: "Notifications are disabled for Threadnote in System Settings."
    case .authorized, .provisional, .ephemeral: "Threadnote notifications are allowed."
    @unknown default: "Notification permission status is unavailable."
    }
  }

  func enable() async {
    do {
      _ = try await center.requestAuthorization(options: [.alert, .sound])
    } catch {
      // The permission state below gives Settings a stable, actionable status.
    }
    await refreshAuthorizationStatus()
  }

  func refreshAuthorizationStatus() async {
    authorizationStatus = await center.notificationSettings().authorizationStatus
  }

  func post(_ kind: ThreadnoteNotificationKind, title: String, body: String) {
    let defaults = UserDefaults.standard
    guard defaults.bool(forKey: NotificationPreference.enabled),
      defaults.bool(forKey: kind.preferenceKey),
      authorizationStatus == .authorized || authorizationStatus == .provisional
    else { return }

    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  func openSystemSettings() {
    guard
      let url = URL(
        string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
      )
    else { return }
    NSWorkspace.shared.open(url)
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}
