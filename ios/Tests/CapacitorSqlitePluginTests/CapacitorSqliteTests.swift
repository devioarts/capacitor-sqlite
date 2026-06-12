import XCTest
@testable import CapacitorSqlitePlugin

class CapacitorSqliteTests: XCTestCase {

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

    // MARK: - isAvailable

    func testIsAvailable() {
        XCTAssertTrue(impl.isAvailable())
    }

    // MARK: - open / close / isOpen

    func testOpenMemoryDatabase() throws {
        XCTAssertNoThrow(try impl.open(database: ":memory:", readonly: false, migrations: []))
        XCTAssertTrue(impl.isOpen(database: ":memory:"))
    }

    func testOpenIsIdempotent() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        XCTAssertNoThrow(try impl.open(database: ":memory:", readonly: false, migrations: []))
        XCTAssertTrue(impl.isOpen(database: ":memory:"))
    }

    func testOpenWithDifferentReadonlyModeThrows() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: true, migrations: []))
    }

    func testCloseDatabase() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        XCTAssertNoThrow(try impl.close(database: ":memory:"))
        XCTAssertFalse(impl.isOpen(database: ":memory:"))
    }

    func testCloseNotOpenThrows() {
        XCTAssertThrowsError(try impl.close(database: ":memory:"))
    }

    // MARK: - Invalid names

    func testInvalidDatabaseNamePathTraversal() {
        XCTAssertThrowsError(try impl.open(database: "../evil", readonly: false, migrations: []))
    }

    func testInvalidDatabaseNameSlash() {
        XCTAssertThrowsError(try impl.open(database: "test/db", readonly: false, migrations: []))
    }

    func testInvalidDatabaseNameEmpty() {
        XCTAssertThrowsError(try impl.open(database: "", readonly: false, migrations: []))
    }

    // MARK: - Calls before initialization

    func testExecuteBeforeOpenThrows() {
        XCTAssertThrowsError(try impl.execute(database: "notopen", statements: ["SELECT 1"]))
    }

    func testRunBeforeOpenThrows() {
        XCTAssertThrowsError(try impl.run(database: "notopen", statement: "SELECT 1", values: []))
    }

    func testQueryBeforeOpenThrows() {
        XCTAssertThrowsError(try impl.query(database: "notopen", statement: "SELECT 1", values: []))
    }

    // MARK: - Basic CRUD

    func testExecuteCreateTableReturnsZeroChanges() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        let changes = try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        ])
        XCTAssertEqual(changes, 0)
    }

    func testRunInsertAndQuery() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        ])

        let insertResult = try impl.run(database: ":memory:", statement: "INSERT INTO users (name) VALUES (?)", values: ["Alice"])
        XCTAssertEqual(insertResult.changes, 1)
        XCTAssertEqual(insertResult.lastInsertId, 1)

        let rows = try impl.query(database: ":memory:", statement: "SELECT * FROM users", values: [])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0]["name"] as? String, "Alice")
    }

    func testRunBatch() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
        ])

        let set: [[String: Any]] = [
            ["statement": "INSERT INTO t (v) VALUES (?)", "values": ["a"] as [Any]],
            ["statement": "INSERT INTO t (v) VALUES (?)", "values": ["b"] as [Any]]
        ]
        let result = try impl.runBatch(database: ":memory:", set: set, transaction: true)
        XCTAssertEqual(result.changes, 2)
        XCTAssertEqual(result.lastInsertId, 0)
    }

    func testRunUpdateReturnsZeroLastInsertId() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"
        ])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t (v) VALUES (?)", values: ["a"])

        let result = try impl.run(database: ":memory:", statement: "UPDATE t SET v = ? WHERE id = ?", values: ["b", 1])
        XCTAssertEqual(result.changes, 1)
        XCTAssertEqual(result.lastInsertId, 0)
    }

    func testExecuteRollsBackByDefault() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT NOT NULL)"])

        XCTAssertThrowsError(
            try impl.execute(database: ":memory:", statements: [
                "INSERT INTO t (v) VALUES ('kept only without transaction')",
                "INSERT INTO t (v) VALUES (NULL)"
            ])
        )

        let rows = try impl.query(database: ":memory:", statement: "SELECT * FROM t", values: [])
        XCTAssertEqual(rows.count, 0)
    }

    func testExecuteCanRunWithoutTransaction() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v TEXT NOT NULL)"])

        XCTAssertThrowsError(
            try impl.execute(
                database: ":memory:",
                statements: [
                    "INSERT INTO t (v) VALUES ('kept')",
                    "INSERT INTO t (v) VALUES (NULL)"
                ],
                transaction: false
            )
        )

        let rows = try impl.query(database: ":memory:", statement: "SELECT * FROM t", values: [])
        XCTAssertEqual(rows.count, 1)
    }

    // MARK: - Transactions

    func testTransactionCommit() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY)"])

        try impl.beginTransaction(database: ":memory:")
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (1)", values: [])
        try impl.commitTransaction(database: ":memory:")

        let rows = try impl.query(database: ":memory:", statement: "SELECT * FROM t", values: [])
        XCTAssertEqual(rows.count, 1)
    }

    func testTransactionRollback() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY)"])

        try impl.beginTransaction(database: ":memory:")
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (1)", values: [])
        try impl.rollbackTransaction(database: ":memory:")

        let rows = try impl.query(database: ":memory:", statement: "SELECT * FROM t", values: [])
        XCTAssertEqual(rows.count, 0)
    }

    func testNestedBeginTransactionThrows() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.beginTransaction(database: ":memory:")
        XCTAssertThrowsError(try impl.beginTransaction(database: ":memory:"))
        try? impl.rollbackTransaction(database: ":memory:")
    }

    func testExecuteTransactionInsideBeginTransactionThrows() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY)"])
        try impl.beginTransaction(database: ":memory:")
        XCTAssertThrowsError(
            try impl.execute(database: ":memory:", statements: ["INSERT INTO t VALUES (1)"], transaction: true)
        )
        try? impl.rollbackTransaction(database: ":memory:")
    }

    func testRunBatchTransactionInsideBeginTransactionThrows() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (id INTEGER PRIMARY KEY)"])
        try impl.beginTransaction(database: ":memory:")
        XCTAssertThrowsError(
            try impl.runBatch(
                database: ":memory:",
                set: [["statement": "INSERT INTO t VALUES (?)", "values": [1] as [Any]]],
                transaction: true
            )
        )
        try? impl.rollbackTransaction(database: ":memory:")
    }

    // MARK: - Migrations

    func testMigrationsApplied() throws {
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["CREATE TABLE v1 (id INTEGER PRIMARY KEY)"]],
            ["version": 2, "statements": ["CREATE TABLE v2 (id INTEGER PRIMARY KEY)"]]
        ]
        try impl.open(database: ":memory:", readonly: false, migrations: migrations)

        let rows1 = try impl.query(database: ":memory:", statement: "SELECT name FROM sqlite_master WHERE name='v1'", values: [])
        XCTAssertEqual(rows1.count, 1)

        let rows2 = try impl.query(database: ":memory:", statement: "SELECT name FROM sqlite_master WHERE name='v2'", values: [])
        XCTAssertEqual(rows2.count, 1)
    }

    func testMigrationMissingVersionThrows() {
        let migrations: [[String: Any]] = [
            ["statements": ["CREATE TABLE t (id INTEGER PRIMARY KEY)"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testMigrationMissingStatementsThrows() {
        let migrations: [[String: Any]] = [
            ["version": 1]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testMigrationFailureThrows() {
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["THIS IS NOT VALID SQL !!!@#$%"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    // MARK: - Param binding

    func testBindInteger() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v INTEGER)"])
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (?)", values: [42])
        let rows = try impl.query(database: ":memory:", statement: "SELECT v FROM t", values: [])
        XCTAssertEqual(rows[0]["v"] as? Int64, 42)
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
        let result = rows[0]["v"] as? [Int]
        XCTAssertEqual(result, [0xDE, 0xAD, 0xBE, 0xEF])
    }

    // MARK: - Foreign keys

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
