import Foundation

struct AgentIntegrationStatus: Decodable, Equatable, Sendable {
  let agent: AgentClient
  let available: Bool
  let detail: String
  let installed: Bool
}

enum IntegrationStatusParser {
  static func parse(_ output: String) throws -> [AgentIntegrationStatus] {
    let decoder = JSONDecoder()
    for line in output.split(whereSeparator: \Character.isNewline).reversed() {
      let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
      guard candidate.hasPrefix("["), candidate.hasSuffix("]") else { continue }
      if let data = candidate.data(using: .utf8),
        let statuses = try? decoder.decode([AgentIntegrationStatus].self, from: data)
      {
        return statuses
      }
    }
    throw IntegrationStatusError.invalidResponse
  }
}

enum IntegrationStatusError: LocalizedError {
  case invalidResponse

  var errorDescription: String? {
    "Threadnote returned an invalid agent integration status."
  }
}
