import XCTest

@testable import Threadnote

final class MemoryActivityMonitorTests: XCTestCase {
  func testOnlyMatchesUserMemoryMarkdown() {
    XCTAssertTrue(
      MemorySnapshot.isMemoryFile(
        URL(fileURLWithPath: "/tmp/viking/local/user/me/memories/durable/feature.md")
      )
    )
    XCTAssertFalse(
      MemorySnapshot.isMemoryFile(
        URL(fileURLWithPath: "/tmp/viking/local/user/me/memories/durable/.abstract.md")
      )
    )
    XCTAssertFalse(
      MemorySnapshot.isMemoryFile(
        URL(fileURLWithPath: "/tmp/viking/local/user/me/resources/feature.md")
      )
    )
  }

  func testDetectsCreatedAndUpdatedMemoriesButNotDeletion() {
    let first = MemoryFileState(modifiedAt: Date(timeIntervalSince1970: 1), size: 10)
    let updated = MemoryFileState(modifiedAt: Date(timeIntervalSince1970: 2), size: 12)
    let path = "/tmp/memories/feature.md"

    XCTAssertTrue(MemorySnapshot.containsStoredMemory(previous: [:], current: [path: first]))
    XCTAssertTrue(
      MemorySnapshot.containsStoredMemory(previous: [path: first], current: [path: updated])
    )
    XCTAssertFalse(MemorySnapshot.containsStoredMemory(previous: [path: first], current: [:]))
  }
}
