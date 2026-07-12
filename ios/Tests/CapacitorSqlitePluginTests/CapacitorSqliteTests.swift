import XCTest
@testable import CapacitorSqlitePlugin

// swiftlint:disable:next type_body_length
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

    func testOpenFileDatabaseNameIsCaseInsensitiveForRegistry() throws {
        try impl.open(database: "CaseAliasTest", readonly: false, migrations: [])
        XCTAssertNoThrow(try impl.open(database: "casealiastest", readonly: false, migrations: []))
        XCTAssertThrowsError(try impl.open(database: "casealiastest", readonly: true, migrations: []))
        XCTAssertTrue(impl.isOpen(database: "casealiastest"))
        try impl.close(database: "casealiastest")
        XCTAssertFalse(impl.isOpen(database: "CaseAliasTest"))
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

    func testRunCteInsertReturnsLastInsertId() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        ])

        let result = try impl.run(
            database: ":memory:",
            statement: "WITH cte(name) AS (SELECT ?) INSERT INTO users (name) SELECT name FROM cte",
            values: ["Bob"]
        )

        XCTAssertEqual(result.changes, 1)
        XCTAssertEqual(result.lastInsertId, 1)
    }

    func testRunCommentPrefixedInsertReturnsLastInsertId() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"
        ])

        let result = try impl.run(
            database: ":memory:",
            statement: "/* lead */ INSERT INTO users (name) VALUES (?)",
            values: ["Cara"]
        )

        XCTAssertEqual(result.changes, 1)
        XCTAssertEqual(result.lastInsertId, 1)
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

    func testMigrationVersionAtMaxIsAccepted() throws {
        let migrations: [[String: Any]] = [
            ["version": 2_147_483_647, "statements": ["CREATE TABLE v1 (id INTEGER PRIMARY KEY)"]]
        ]
        try impl.open(database: ":memory:", readonly: false, migrations: migrations)
        let version = try impl.getSchemaVersion(database: ":memory:")
        XCTAssertEqual(version, 2_147_483_647)
    }

    func testMigrationVersionAboveMaxThrows() {
        // One past the 32-bit signed ceiling shared by every backend (matches SQLite's own
        // `user_version` field width) — must be rejected up front, not silently truncated.
        let migrations: [[String: Any]] = [
            ["version": 2_147_483_648, "statements": ["CREATE TABLE v1 (id INTEGER PRIMARY KEY)"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testMigrationMissingStatementsThrows() {
        let migrations: [[String: Any]] = [
            ["version": 1]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testDuplicateMigrationVersionsThrow() {
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["CREATE TABLE v1a (id INTEGER PRIMARY KEY)"]],
            ["version": 1, "statements": ["CREATE TABLE v1b (id INTEGER PRIMARY KEY)"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testMigrationFailureThrows() {
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["THIS IS NOT VALID SQL !!!@#$%"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testMigrationRejectsMultipleStatementsInOneString() {
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER)"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: false, migrations: migrations))
    }

    func testReadonlyWithMigrationsThrows() {
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["CREATE TABLE t (id INTEGER PRIMARY KEY)"]]
        ]
        XCTAssertThrowsError(try impl.open(database: ":memory:", readonly: true, migrations: migrations))
    }

    func testPendingMigrationAppliesWhileConnectionAlreadyOpen() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["CREATE TABLE added_live (v INTEGER)"]]
        ]
        try impl.open(database: ":memory:", readonly: false, migrations: migrations)
        XCTAssertEqual(try impl.getSchemaVersion(database: ":memory:"), 1)
        let rows = try impl.query(
            database: ":memory:",
            statement: "SELECT name FROM sqlite_master WHERE name='added_live'",
            values: []
        )
        XCTAssertEqual(rows.count, 1)
    }

    func testMigrationWhileTransactionActiveIsRejectedWithoutEndingTransaction() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.beginTransaction(database: ":memory:")
        let migrations: [[String: Any]] = [
            ["version": 1, "statements": ["CREATE TABLE must_not_exist (v INTEGER)"]]
        ]
        XCTAssertThrowsError(
            try impl.open(database: ":memory:", readonly: false, migrations: migrations)
        )
        XCTAssertNoThrow(try impl.rollbackTransaction(database: ":memory:"))
        XCTAssertEqual(try impl.getSchemaVersion(database: ":memory:"), 0)
    }

    func testOrRollbackSynchronizesTransactionState() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t (v INTEGER UNIQUE)",
            "INSERT INTO t VALUES (1)"
        ])
        try impl.beginTransaction(database: ":memory:")
        _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES (2)", values: [])
        XCTAssertThrowsError(
            try impl.run(database: ":memory:", statement: "INSERT OR ROLLBACK INTO t VALUES (1)", values: [])
        )
        XCTAssertNoThrow(try impl.beginTransaction(database: ":memory:"))
        XCTAssertNoThrow(try impl.rollbackTransaction(database: ":memory:"))
    }

}
