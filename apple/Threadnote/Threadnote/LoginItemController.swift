import Combine
import ServiceManagement

@MainActor
final class LoginItemController: ObservableObject {
  @Published private(set) var enabled = false
  @Published private(set) var requiresApproval = false
  @Published private(set) var errorMessage: String?

  init() {
    refresh()
  }

  func refresh() {
    switch SMAppService.mainApp.status {
    case .enabled:
      enabled = true
      requiresApproval = false
    case .requiresApproval:
      enabled = false
      requiresApproval = true
    default:
      enabled = false
      requiresApproval = false
    }
  }

  func setEnabled(_ shouldEnable: Bool) {
    errorMessage = nil
    do {
      if shouldEnable {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
    } catch {
      errorMessage = error.localizedDescription
    }
    refresh()
  }

  func openSystemSettings() {
    SMAppService.openSystemSettingsLoginItems()
  }
}
