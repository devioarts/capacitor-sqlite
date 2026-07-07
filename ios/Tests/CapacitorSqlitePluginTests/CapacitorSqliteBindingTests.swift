import XCTest
@testable import CapacitorSqlitePlugin

class CapacitorSqliteBindingTests: XCTestCase {

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

    func testBindInteger() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v INTEGER)"])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [42])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? Int64, 42)
    }

    func testBindUnsafeIntegerThrowsInsteadOfCrashing() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v)"])

        let tooLargeForInt64 = pow(2.0, 63.0)
        XCTAssertThrowsError(
            try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [tooLargeForInt64])
        )
    }

    func testExecuteRejectsMultipleStatementsInOneString() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        XCTAssertThrowsError(
            try impl.execute(database: ":memory:", statements: ["CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER)"])
        )
    }

    func testRunRejectsMultipleStatementsInOneString() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        XCTAssertThrowsError(
            try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES ('a'); INSERT INTO t VALUES ('b')", values: [])
        )
    }

    func testQueryRejectsMultipleStatementsInOneString() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        XCTAssertThrowsError(try impl.query(database: ":memory:", statement: "SELECT 1; SELECT 2", values: []))
    }

    func testExecuteRejectsStatementAfterLeadingBeginTransaction() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        XCTAssertThrowsError(
            try impl.execute(database: ":memory:", statements: ["BEGIN; DROP TABLE t"])
        )
        XCTAssertThrowsError(
            try impl.execute(database: ":memory:", statements: ["BEGIN TRANSACTION; DROP TABLE t; COMMIT"])
        )
        let rows = try impl.query(
            database: ":memory:",
            statement: "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 't'",
            values: []
        )
        XCTAssertEqual(rows[0]["n"] as? Int64, 1)
    }

    func testBindText() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: ["hello"])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? String, "hello")
    }

    func testBindNull() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [NSNull()])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertTrue(rows[0]["v"] is NSNull)
    }

    func testBindBlob() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v BLOB)"])
        let data = Data([0xDE, 0xAD, 0xBE, 0xEF])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [data])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? String, "blob64:" + data.base64EncodedString())
    }

    func testBindArrayBlobAcceptsFullByteRange() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v BLOB)"])
        let bytes: [Int] = [0, 128, 255]
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [bytes])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? String, "blob64:" + Data([0, 128, 255]).base64EncodedString())
    }

    func testBindArrayBlobRejectsOutOfRangeByteInsteadOfClamping() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v BLOB)"])
        // 256 and -1 previously clamped silently to 255 and 0; must now throw, matching
        // Android's byteArrayFromList and Electron's isByteArray.
        XCTAssertThrowsError(
            try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [[256]])
        )
        XCTAssertThrowsError(
            try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [[-1]])
        )
    }

    func testUnsafeIntegerResultReturnsString() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t (v INTEGER)",
            "INSERT INTO t VALUES (9223372036854775807)"
        ])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? String, "9223372036854775807")
    }

    func testRunDdlReturnsZeroChangesAfterInsert() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT)"])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: ["a"])
        let result = try impl.run(database: ":memory:", statement: "CREATE TABLE u (v TEXT)", values: [])
        XCTAssertEqual(result.changes, 0)
    }

    func testForeignKeysEnabled() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE parent (id INTEGER PRIMARY KEY)",
            "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))"
        ])
        XCTAssertThrowsError(
            try impl.run(database: ":memory:", statement: "INSERT INTO child (parent_id) VALUES (99)", values: [])
        )
    }
}
