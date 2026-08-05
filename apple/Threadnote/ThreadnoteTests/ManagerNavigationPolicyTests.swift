import XCTest

@testable import Threadnote

final class ManagerNavigationPolicyTests: XCTestCase {
  func testAllowsNavigationWithinManagerOrigin() throws {
    let managerURL = try XCTUnwrap(URL(string: "http://127.0.0.1:49152/?token=secret"))
    let apiURL = try XCTUnwrap(URL(string: "http://127.0.0.1:49152/api/state"))

    XCTAssertTrue(ManagerNavigationPolicy(managerURL: managerURL).allows(apiURL))
  }

  func testRejectsDifferentPortAndHost() throws {
    let managerURL = try XCTUnwrap(URL(string: "http://127.0.0.1:49152/?token=secret"))
    let policy = ManagerNavigationPolicy(managerURL: managerURL)

    XCTAssertFalse(policy.allows(try XCTUnwrap(URL(string: "http://127.0.0.1:49153/"))))
    XCTAssertFalse(policy.allows(try XCTUnwrap(URL(string: "https://example.com/"))))
  }
}
