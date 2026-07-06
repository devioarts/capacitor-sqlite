import XCTest
@testable import CapacitorSqlitePlugin

class CapacitorSqliteTextTests: XCTestCase {

    // swiftlint:disable:next implicitly_unwrapped_optional
    var impl: CapacitorSqlite!

    override func setUp() {
        super.setUp()
        impl = CapacitorSqlite()
    }

    override func tearDown() {
        try? impl.close(database: ":memory:")
        impl = nil
        super.tearDown()
    }

    func testTextWithEmbeddedNullByteRoundTrips() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        let text = "a\u{0000}b"
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [text])

        let rows = try impl.query(database: ":memory:", statement: "SELECT v, hex(v) AS hex FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? String, text)
        XCTAssertEqual(rows[0]["hex"] as? String, "610062")
    }

    func testTextStartingWithBlobSentinelIsEscaped() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: ["blob64:test"])

        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? String, "text64:" + Data("blob64:test".utf8).base64EncodedString())
    }
}
