import XCTest

@testable import Threadnote

final class ManagerURLParserTests: XCTestCase {
  func testParsesLoopbackManagerURL() throws {
    let output = """
      Threadnote manager: http://127.0.0.1:49152/?token=secret-token
      Press Ctrl-C to stop the manager.
      """

    let url = try XCTUnwrap(ManagerURLParser.parse(output))

    XCTAssertEqual(url.host, "127.0.0.1")
    XCTAssertEqual(url.port, 49152)
    XCTAssertEqual(
      URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value,
      "secret-token")
  }

  func testRejectsNonLoopbackURL() {
    let output = "Threadnote manager: https://example.com/?token=secret-token"

    XCTAssertNil(ManagerURLParser.parse(output))
  }

  func testRejectsURLWithoutToken() {
    let output = "Threadnote manager: http://127.0.0.1:49152/"

    XCTAssertNil(ManagerURLParser.parse(output))
  }
}
