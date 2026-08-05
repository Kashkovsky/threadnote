import Foundation
import XCTest

@testable import Threadnote

final class ProcessRunnerTests: XCTestCase {
  func testPassesArgumentsWithoutShellEvaluation() async throws {
    let command = ThreadnoteCommand(executable: URL(fileURLWithPath: "/usr/bin/printf"))

    let result = try await ProcessRunner().run(
      command: command,
      arguments: ["%s", "$(touch should-not-run); $HOME"],
      timeout: 5
    )

    XCTAssertEqual(result.output, "$(touch should-not-run); $HOME")
  }

  func testReportsNonZeroExit() async {
    let command = ThreadnoteCommand(executable: URL(fileURLWithPath: "/usr/bin/false"))

    do {
      _ = try await ProcessRunner().run(command: command, arguments: [], timeout: 5)
      XCTFail("Expected a non-zero exit error")
    } catch let error as CommandRunnerError {
      guard case .nonZeroExit(let code, _) = error else {
        return XCTFail("Unexpected error: \(error)")
      }
      XCTAssertEqual(code, 1)
    } catch {
      XCTFail("Unexpected error: \(error)")
    }
  }
}
