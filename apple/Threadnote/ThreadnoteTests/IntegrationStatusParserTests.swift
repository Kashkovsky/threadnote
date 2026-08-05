import XCTest

@testable import Threadnote

final class IntegrationStatusParserTests: XCTestCase {
  func testParsesStatusJSONAfterCommandOutput() throws {
    let output = """
      Checking integrations…
      [{"agent":"codex","available":true,"detail":"Configured in Codex","installed":true},{"agent":"claude","available":false,"detail":"Claude command not found","installed":false}]
      """

    let statuses = try IntegrationStatusParser.parse(output)

    XCTAssertEqual(
      statuses,
      [
        AgentIntegrationStatus(
          agent: .codex,
          available: true,
          detail: "Configured in Codex",
          installed: true
        ),
        AgentIntegrationStatus(
          agent: .claude,
          available: false,
          detail: "Claude command not found",
          installed: false
        ),
      ]
    )
  }

  func testRejectsOutputWithoutStatusJSON() {
    XCTAssertThrowsError(try IntegrationStatusParser.parse("No integrations found"))
  }
}
