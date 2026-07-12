import XCTest
@testable import CapacitorSqlitePlugin

final class PreparedBatchTests: XCTestCase {
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

    func testCountsTriggerChangesAfterPreparedStatementReuse() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE main_t (v INTEGER)",
            "CREATE TABLE audit_t (v INTEGER)",
            "CREATE TRIGGER batch_trigger AFTER INSERT ON main_t " +
                "BEGIN INSERT INTO audit_t VALUES (NEW.v); END"
        ])
        let statement = "INSERT INTO main_t VALUES (?)"
        let result = try impl.runBatch(
            database: ":memory:",
            set: [
                ["statement": statement, "values": [1] as [Any]],
                ["statement": statement, "values": [2] as [Any]]
            ],
            transaction: true
        )
        XCTAssertEqual(result.changes, 4)
        XCTAssertEqual(result.lastInsertId, 0)
    }

    func testRebindsNullAndBlobWithoutLeakingPreviousValues() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: [
            "CREATE TABLE t (id INTEGER, text_value TEXT, blob_value BLOB)"
        ])
        let statement = "INSERT INTO t VALUES (?, ?, ?)"
        let result = try impl.runBatch(
            database: ":memory:",
            set: [
                ["statement": statement, "values": [1, "first", Data([1, 2])] as [Any]],
                ["statement": statement, "values": [2, NSNull(), Data()] as [Any]],
                ["statement": statement, "values": [3, "third", Data([255, 0, 128])] as [Any]]
            ],
            transaction: true
        )
        XCTAssertEqual(result.changes, 3)
        let rows = try impl.query(
            database: ":memory:",
            statement: "SELECT id, text_value, hex(blob_value) AS blob_hex FROM t ORDER BY id",
            values: []
        )
        XCTAssertEqual(rows.count, 3)
        XCTAssertTrue(rows[1]["text_value"] is NSNull)
        XCTAssertEqual(rows[0]["blob_hex"] as? String, "0102")
        XCTAssertEqual(rows[1]["blob_hex"] as? String, "")
        XCTAssertEqual(rows[2]["blob_hex"] as? String, "FF0080")
    }

    func testTransactionalBatchValidatesEveryBindBeforeFirstWrite() throws {
        try impl.open(database: ":memory:", readonly: false, migrations: [])
        try impl.execute(database: ":memory:", statements: ["CREATE TABLE t (v INTEGER)"])

        XCTAssertThrowsError(try impl.runBatch(
            database: ":memory:",
            set: [
                ["statement": "INSERT INTO t VALUES (?)", "values": [1] as [Any]],
                ["statement": "INSERT INTO t VALUES (?)", "values": [2, 3] as [Any]]
            ],
            transaction: true
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
}
