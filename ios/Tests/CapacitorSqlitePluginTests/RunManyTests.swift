import XCTest
@testable import CapacitorSqlitePlugin

final class RunManyTests: XCTestCase {
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var impl: CapacitorSqlite!

    override func setUp() {
        super.setUp()
        impl = CapacitorSqlite()
    }

    override func tearDown() {
        impl.closeAll()
        impl = nil
        super.tearDown()
    }

    func testReusesStatementAndReturnsPerItemIds() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
        ])
        let result = try impl.runMany(
            database: ":memory:",
            statement: "INSERT INTO t (v) VALUES (?)",
            valueSets: [["a"], ["b"], ["c"]],
            transaction: true,
            returnResults: true
        )
        XCTAssertEqual(result.changes, 3)
        XCTAssertEqual(result.results?.map(\.lastInsertId), [1, 2, 3])
    }

    func testConstraintFailureRollsBackDefaultTransaction() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v INTEGER UNIQUE)"])
        XCTAssertThrowsError(try impl.runMany(
            database: ":memory:",
            statement: "INSERT INTO t VALUES (?)",
            valueSets: [[1], [2], [1]],
            transaction: true,
            returnResults: false
        ))
        let rows = try impl.query(database: ":memory:", statement: "SELECT COUNT(*) AS n FROM t", values: [])
        XCTAssertEqual(rows[0]["n"] as? Int64, 0)
    }

    func testValidatesAllBindCountsBeforeFirstWrite() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v INTEGER)"])

        XCTAssertThrowsError(try impl.runMany(
            database: ":memory:",
            statement: "INSERT INTO t VALUES (?)",
            valueSets: [[1], [2, 3]],
            transaction: true,
            returnResults: false
        )) { error in
            guard case CapacitorSqliteError.failed(let code, let message) = error else {
                return XCTFail("Expected CapacitorSqliteError.failed, got \(error)")
            }
            XCTAssertEqual(code, "INVALID_PARAMS")
            XCTAssertTrue(message.contains("Bind value count mismatch"))
        }

        let rows = try impl.query(database: ":memory:", statement: "SELECT COUNT(*) AS n FROM t", values: [])
        XCTAssertEqual(rows[0]["n"] as? Int64, 0)
    }

    func testCompactRowsKeepColumnsForEmptyAndPopulatedResults() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (id INTEGER, v TEXT)"])
        var compact = try impl.queryCompact(database: ":memory:", statement: "SELECT id, v FROM t", values: [])
        XCTAssertEqual(compact.columns, ["id", "v"])
        XCTAssertTrue(compact.values.isEmpty)
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?, ?)", values: [1, "a"])
        compact = try impl.queryCompact(database: ":memory:", statement: "SELECT id, v FROM t", values: [])
        XCTAssertEqual(compact.values.count, 1)
        XCTAssertEqual(compact.values[0][0] as? Int64, 1)
    }

    func testCompactQueryBindCountFailuresRemainInvalidParams() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])

        for values: [Any] in [[1], [1, 2, 3]] {
            XCTAssertThrowsError(try impl.queryCompact(
                database: ":memory:",
                statement: "SELECT ? AS a, ? AS b",
                values: values
            )) { error in
                guard case CapacitorSqliteError.failed(let code, let message) = error else {
                    return XCTFail("Expected CapacitorSqliteError.failed, got \(error)")
                }
                XCTAssertEqual(code, "INVALID_PARAMS")
                XCTAssertTrue(message.contains("Bind value count mismatch"))
            }
        }
    }
}
