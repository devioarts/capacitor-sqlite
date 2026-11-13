import XCTest
@testable import CapacitorSqlitePlugin

final class ReturningTests: XCTestCase {
    // swiftlint:disable:next implicitly_unwrapped_optional
    private var database: Database!

    override func setUpWithError() throws {
        database = Database(name: ":memory:", path: ":memory:")
        try database.open()
        try database.execute(statements: ["CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER UNIQUE)"])
    }

    override func tearDownWithError() throws {
        try database.close()
        database = nil
    }

    func testRunDrainsAllReturningRowsBeforeReportingChanges() throws {
        let inserted = try database.run(statement: "INSERT INTO t VALUES (1, 10), (2, 20), (3, 30) RETURNING id")
        XCTAssertEqual(inserted.changes, 3)
        XCTAssertEqual(inserted.lastInsertId, 3)
        let updated = try database.run(statement: "UPDATE t SET v = v + 1 RETURNING id")
        XCTAssertEqual(updated.changes, 3)
        XCTAssertEqual(updated.lastInsertId, 0)
        let deleted = try database.run(statement: "DELETE FROM t RETURNING id")
        XCTAssertEqual(deleted.changes, 3)
        XCTAssertEqual(deleted.lastInsertId, 0)
        XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, 0)
    }

    func testRunManyReturningCommitsWithAndWithoutPerItemResults() throws {
        for detailed in [false, true] {
            try database.execute(statements: ["DELETE FROM t"])
            let result = try database.runMany(
                statement: "INSERT INTO t VALUES (?, ?) RETURNING id",
                valueSets: [[1, 10], [2, 20], [3, 30]],
                transaction: true,
                returnResults: detailed
            )
            XCTAssertEqual(result.changes, 3)
            if detailed {
                XCTAssertEqual(result.results?.map(\.changes), [1, 1, 1])
                XCTAssertEqual(result.results?.map(\.lastInsertId), [1, 2, 3])
            } else {
                XCTAssertNil(result.results)
            }
            XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, 3)
        }
    }

    func testRunBatchReturningCommitsAtomicAndAutocommitWrites() throws {
        for transaction in [false, true] {
            try database.execute(statements: ["DELETE FROM t"])
            let result = try database.runBatch(set: [
                ["statement": "INSERT INTO t VALUES (1, 10) RETURNING id"],
                ["statement": "UPDATE t SET v = 11 RETURNING id"],
                ["statement": "INSERT INTO t VALUES (2, 20) RETURNING id"],
                ["statement": "DELETE FROM t WHERE id = 1 RETURNING id"]
            ], transaction: transaction)
            XCTAssertEqual(result.changes, 4)
            let rows = try database.query(statement: "SELECT id FROM t")
            XCTAssertEqual(rows.count, 1)
            XCTAssertEqual(rows[0]["id"] as? Int64, 2)
        }
    }

    func testReturningPreservesOuterTransactionAndRollback() throws {
        try database.beginTransaction()
        let result = try database.runMany(
            statement: "INSERT INTO t VALUES (?, ?) RETURNING id",
            valueSets: [[1, 10], [2, 20]], transaction: false, returnResults: true
        )
        XCTAssertEqual(result.changes, 2)
        try database.rollbackTransaction()
        XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, 0)
    }

    func testReturningConstraintFailureKeepsAtomicAndAutocommitSemantics() throws {
        for transaction in [true, false] {
            try database.execute(statements: ["DELETE FROM t"])
            XCTAssertThrowsError(try database.runMany(
                statement: "INSERT INTO t VALUES (?, ?) RETURNING id",
                valueSets: [[1, 10], [2, 10]], transaction: transaction, returnResults: true
            ))
            XCTAssertEqual(try database.query(statement: "SELECT * FROM t").count, transaction ? 0 : 1)
            try database.beginTransaction()
            try database.rollbackTransaction()
        }
    }

    func testReturningCountsTriggerChangesAndKeepsQueryRows() throws {
        try database.execute(statements: [
            "CREATE TABLE log(v INTEGER)",
            "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (NEW.id); END"
        ])
        let result = try database.run(statement: "INSERT INTO t VALUES (1, 10), (2, 20) RETURNING id")
        XCTAssertEqual(result.changes, 4)
        XCTAssertEqual(result.lastInsertId, 2)
        let rows = try database.query(statement: "INSERT INTO t VALUES (3, 30) RETURNING id")
        XCTAssertEqual(rows[0]["id"] as? Int64, 3)
        XCTAssertEqual(try database.query(statement: "SELECT * FROM log").count, 3)
    }

    func testReturningWithNoMatchingRowsReportsZero() throws {
        let result = try database.run(statement: "UPDATE t SET v = 1 WHERE id = 999 RETURNING id")
        XCTAssertEqual(result.changes, 0)
        XCTAssertEqual(result.lastInsertId, 0)
    }
}
