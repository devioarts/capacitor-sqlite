import XCTest
@testable import CapacitorSqlitePlugin

final class BatchPreparationTests: XCTestCase {
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var database: Database!

    override func setUpWithError() throws {
        database = Database(name: ":memory:", path: ":memory:")
        try database.open()
    }

    override func tearDownWithError() throws {
        try database.close()
        database = nil
    }

    func testBatchPreparesAfterEarlierSchemaChanges() throws {
        for transaction in [true, false] {
            let result = try database.runBatch(set: [
                ["statement": "CREATE TABLE t(v)"],
                ["statement": "INSERT INTO t VALUES (?)", "values": [1]],
                ["statement": "INSERT INTO t VALUES (?)", "values": [2]]
            ], transaction: transaction)
            XCTAssertEqual(result.changes, 2)
            XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, 2)
            try database.execute(statements: ["DROP TABLE t"])
        }
    }

    func testPreparedCachePreservesDifferentUnicodeNormalizations() throws {
        try database.execute(statements: ["CREATE TABLE t(v TEXT)"])
        for transaction in [true, false] {
            _ = try database.runBatch(set: [
                ["statement": "INSERT INTO t VALUES ('é')"],
                ["statement": "INSERT INTO t VALUES ('e\u{0301}')"]
            ], transaction: transaction)
            let rows = try database.query(statement: "SELECT hex(v) AS bytes FROM t ORDER BY rowid")
            XCTAssertEqual(rows.compactMap { $0["bytes"] as? String }, ["C3A9", "65CC81"])
            try database.execute(statements: ["DELETE FROM t"])
        }
    }

    func testTransactionalFailureRollsBackEarlierSchemaChanges() throws {
        XCTAssertThrowsError(try database.runBatch(set: [
            ["statement": "CREATE TABLE t(v)"],
            ["statement": "INSERT INTO missing VALUES (1)"]
        ]))
        XCTAssertEqual(try database.query(statement: "SELECT name FROM sqlite_master WHERE name = 't'").count, 0)
        XCTAssertFalse(database.inTransaction)
    }

    func testPragmaPreparationHappensInsideOwningTransaction() throws {
        XCTAssertThrowsError(try database.runBatch(set: [
            ["statement": "PRAGMA foreign_keys = OFF"],
            ["statement": "INSERT INTO missing VALUES (1)"]
        ]))
        XCTAssertEqual(try foreignKeys(), 1)
        _ = try database.runMany(statement: "PRAGMA foreign_keys = OFF", valueSets: [[]])
        XCTAssertEqual(try foreignKeys(), 1)
    }

    func testInvalidLaterBindDoesNotPrepareEarlierPragmaOrDdl() throws {
        for transaction in [true, false] {
            XCTAssertThrowsError(try database.runBatch(set: [
                ["statement": "PRAGMA foreign_keys = OFF"],
                ["statement": "CREATE TABLE t(v)"],
                ["statement": "INSERT INTO t VALUES (?)", "values": [1, 2]]
            ], transaction: transaction))
            XCTAssertEqual(try foreignKeys(), 1)
            XCTAssertEqual(try database.query(statement: "SELECT name FROM sqlite_master WHERE name = 't'").count, 0)
        }
    }

    func testAutocommitRepreparesEveryPragmaOccurrence() throws {
        _ = try database.runBatch(set: [
            ["statement": "PRAGMA foreign_keys = OFF"],
            ["statement": "PRAGMA foreign_keys = ON"],
            ["statement": "PRAGMA foreign_keys = OFF"]
        ], transaction: false)
        XCTAssertEqual(try foreignKeys(), 0)
    }

    func testInvalidValuesShapePreventsEarlierWrites() throws {
        try database.execute(statements: ["CREATE TABLE t(v)"])
        XCTAssertThrowsError(try database.runBatch(set: [
            ["statement": "INSERT INTO t VALUES (1)"],
            ["statement": "INSERT INTO t VALUES (2)", "values": "not an array"]
        ], transaction: false))
        XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, 0)
    }

    func testUnicodeCannotHideSecondStatementFromExecute() throws {
        try database.execute(statements: ["CREATE TABLE victim(v)"])
        XCTAssertThrowsError(try database.execute(statements: ["SELECT 'a'\u{0301}; DROP TABLE victim"]))
        XCTAssertEqual(try database.query(statement: "SELECT name FROM sqlite_master WHERE name = 'victim'").count, 1)
    }

    func testRawTransactionStatementsAlwaysExposeActualState() throws {
        try database.execute(statements: ["BEGIN"], transaction: false)
        XCTAssertTrue(database.inTransaction)
        XCTAssertThrowsError(try database.beginTransaction())
        _ = try database.run(statement: "COMMIT")
        XCTAssertFalse(database.inTransaction)
        try database.beginTransaction()
        try database.execute(statements: ["ROLLBACK"], transaction: false)
        XCTAssertFalse(database.inTransaction)
        _ = try database.run(statement: "BEGIN")
        XCTAssertTrue(database.inTransaction)
        try database.rollbackTransaction()
        XCTAssertFalse(database.inTransaction)
    }

    func testAtomicMethodsRejectTransactionControlBeforeWriting() throws {
        try database.execute(statements: ["CREATE TABLE t(v)"])
        for sql in [
            "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT user_savepoint", "RELEASE user_savepoint",
            "\u{FEFF}COMMIT", "\u{00A0}COMMIT", "COMMIT\u{00A0}"
        ] {
            let statement = sql.first == "\u{00A0}" ? sql : "/* leading comment */ \(sql)"
            assertInvalidTransactionControl {
                _ = try database.execute(statements: ["INSERT INTO t VALUES (1)", statement])
            }
            assertInvalidTransactionControl {
                _ = try database.runBatch(set: [
                    ["statement": "INSERT INTO t VALUES (1)"], ["statement": statement]
                ])
            }
            assertInvalidTransactionControl {
                _ = try database.runMany(statement: statement, valueSets: [[]])
            }
            XCTAssertFalse(database.inTransaction)
            XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, 0)
        }
    }

    func testMigrationsRejectTransactionControlBeforeAnyVersionChanges() throws {
        XCTAssertThrowsError(try database.open(migrations: [
            MigrationEntry(version: 1, statements: ["CREATE TABLE first_version(v)"]),
            MigrationEntry(version: 2, statements: ["COMMIT\u{00A0}"])
        ])) { error in
            guard case DatabaseError.migration(let message) = error else {
                return XCTFail("Expected migration error, got \(error)")
            }
            XCTAssertTrue(message.contains("transaction control requires transaction:false"))
        }
        XCTAssertEqual(try database.getSchemaVersion(), 0)
        XCTAssertEqual(try database.query(statement: "SELECT name FROM sqlite_master").count, 0)
    }

    private func assertInvalidTransactionControl(_ operation: () throws -> Void) {
        XCTAssertThrowsError(try operation()) { error in
            guard case DatabaseError.invalidParams(let message) = error else {
                return XCTFail("Expected invalidParams, got \(error)")
            }
            XCTAssertEqual(message, "transaction control requires transaction:false")
        }
    }

    private func foreignKeys() throws -> Int64? {
        try database.query(statement: "PRAGMA foreign_keys").first?["foreign_keys"] as? Int64
    }

    func testInvalidLaterMigrationDoesNotCommitEarlierVersion() throws {
        let connection = Database(name: ":memory:", path: ":memory:")
        try connection.open()
        defer { try? connection.close() }
        try connection.execute(statements: ["CREATE TABLE t(v)"])
        XCTAssertThrowsError(try connection.open(migrations: [
            MigrationEntry(version: 1, statements: ["INSERT INTO t VALUES(1)"]),
            MigrationEntry(version: 2, statements: ["INSERT INTO t VALUES(2); INSERT INTO t VALUES(3)"])
        ]))
        XCTAssertEqual(try connection.getSchemaVersion(), 0)
        XCTAssertEqual(try connection.query(statement: "SELECT * FROM t").count, 0)
    }

    func testSafeMigrationRebuildPreservesChildrenAndRestoresForeignKeys() throws {
        let connection = Database(name: ":memory:", path: ":memory:")
        try connection.open()
        defer { try? connection.close() }
        try connection.execute(statements: [
            "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
            "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id REFERENCES parent(id) ON DELETE CASCADE)",
            "INSERT INTO parent VALUES(1)", "INSERT INTO child VALUES(1,1)"
        ])
        try connection.execute(statements: ["PRAGMA foreign_keys=OFF"], transaction: false)
        defer { _ = try? connection.execute(statements: ["PRAGMA foreign_keys=ON"], transaction: false) }
        try connection.open(migrations: [MigrationEntry(version: 1, statements: [
            "CREATE TABLE parent_new(id INTEGER PRIMARY KEY,extra TEXT)",
            "INSERT INTO parent_new(id) SELECT id FROM parent", "DROP TABLE parent",
            "ALTER TABLE parent_new RENAME TO parent"
        ])])
        XCTAssertEqual(try connection.query(statement: "SELECT * FROM child").count, 1)
        XCTAssertEqual(try connection.query(statement: "PRAGMA foreign_key_check").count, 0)
        try connection.execute(statements: ["PRAGMA foreign_keys=ON"], transaction: false)
        XCTAssertThrowsError(try connection.run(statement: "INSERT INTO child VALUES(2,999)"))
    }

    func testSqliteErrorMessagesDoNotContainEnumWrappers() throws {
        let impl = CapacitorSqlite()
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        defer { try? impl.close(database: ":memory:") }
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t(id INTEGER PRIMARY KEY)", "INSERT INTO t VALUES(1)"
        ])
        let actions: [() throws -> Void] = [
            { _ = try impl.run(database: ":memory:", statement: "INSERT INTO t VALUES(1)", values: []) },
            { _ = try impl.runBatch(
                database: ":memory:", set: [["statement": "INSERT INTO t VALUES(1)"]], transaction: true
            ) },
            { _ = try impl.runMany(
                database: ":memory:", statement: "INSERT INTO t VALUES(?)", valueSets: [[1]],
                transaction: true, returnResults: false
            ) }
        ]
        for action in actions {
            XCTAssertThrowsError(try action()) { error in
                guard case CapacitorSqliteError.failed(_, let message) = error else {
                    return XCTFail("Unexpected error: \(error)")
                }
                XCTAssertEqual(message, "UNIQUE constraint failed: t.id")
            }
        }
        let queries: [() throws -> Void] = [
            { _ = try impl.query(database: ":memory:", statement: "SELECT * FROM missing", values: []) },
            { _ = try impl.queryCompact(database: ":memory:", statement: "SELECT * FROM missing", values: []) }
        ]
        for query in queries {
            XCTAssertThrowsError(try query()) { error in
                guard case CapacitorSqliteError.failed(let code, let message) = error else {
                    return XCTFail("Unexpected error: \(error)")
                }
                XCTAssertEqual(code, "QUERY_FAILED")
                XCTAssertEqual(message, "no such table: missing")
            }
        }
    }
}
