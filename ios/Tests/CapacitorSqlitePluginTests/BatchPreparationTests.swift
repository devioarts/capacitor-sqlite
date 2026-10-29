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
}
