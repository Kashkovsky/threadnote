import Foundation

enum ManagerURLParser {
  static func parse(_ output: String) -> URL? {
    for line in output.split(whereSeparator: \.isNewline) {
      guard let marker = line.range(of: "Threadnote manager:") else { continue }
      let value = line[marker.upperBound...].trimmingCharacters(in: .whitespaces)
      guard
        let url = URL(string: value),
        url.scheme == "http",
        url.host == "127.0.0.1",
        url.port != nil,
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
        components.queryItems?.contains(where: { $0.name == "token" && !($0.value ?? "").isEmpty })
          == true
      else {
        continue
      }
      return url
    }
    return nil
  }
}

struct ManagerNavigationPolicy {
  let managerURL: URL

  func allows(_ url: URL) -> Bool {
    url.scheme == managerURL.scheme && url.host == managerURL.host && url.port == managerURL.port
  }
}
