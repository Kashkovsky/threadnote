import Foundation

enum ServiceStatus: Equatable, Sendable {
  case checking
  case healthy
  case stopped
  case unavailable(String)

  var title: String {
    switch self {
    case .checking: "Checking"
    case .healthy: "Healthy"
    case .stopped: "Stopped"
    case .unavailable: "Needs attention"
    }
  }

  var systemImage: String {
    switch self {
    case .checking: "circle.dotted"
    case .healthy: "checkmark.circle.fill"
    case .stopped: "stop.circle"
    case .unavailable: "exclamationmark.triangle.fill"
    }
  }
}

struct HealthClient: Sendable {
  func check(host: String = "127.0.0.1", port: Int = 1933) async -> ServiceStatus {
    guard let url = URL(string: "http://\(host):\(port)/health") else {
      return .unavailable("Invalid health URL")
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 2
    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        return .unavailable("OpenViking returned an invalid response")
      }
      return (200..<300).contains(http.statusCode)
        ? .healthy
        : .unavailable("OpenViking health returned HTTP \(http.statusCode)")
    } catch {
      return .stopped
    }
  }
}
