// swiftlint:disable identifier_name
import Foundation
import SQLite3

enum SQLiteError: Error {
    case open(String)
    case close(String)
    case execute(String)
    case prepare(String)
    case query(String)
    case version(String)
}

enum SQLiteHelpers {

    // Sentinel prefix for BLOB columns returned from queries.
    // The JS layer detects this prefix and decodes back to Uint8Array.
    // Must stay in sync with BLOB_PREFIX in SQLiteHelpers.kt and index.ts.
    static let BLOB_PREFIX = "blob64:"
    static let TEXT_PREFIX = "text64:"
    static let MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

    // MARK: - Lifecycle

    static func open(path: String, readonly: Bool = false) throws -> OpaquePointer {
        // SQLITE_OPEN_NOMUTEX: per-database serialization is handled by Database.queue,
        // so SQLite's own mutex is redundant and would only add overhead.
        let flags = readonly
            ? SQLITE_OPEN_READONLY
            : SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK, let handle = db else {
            let msg = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "open_v2 failed"
            sqlite3_close_v2(db)
            throw SQLiteError.open(msg)
        }
        return handle
    }

    static func close(db: OpaquePointer) throws {
        if sqlite3_close_v2(db) != SQLITE_OK {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "close failed"
            throw SQLiteError.close(msg)
        }
    }

    // MARK: - DDL / no-result execution

    static func exec(db: OpaquePointer, sql: String) throws {
        if hasMultipleStatements(sql) {
            throw SQLiteError.execute("SQL string must contain exactly one statement")
        }
        if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "exec failed"
            throw SQLiteError.execute(msg)
        }
    }

    // MARK: - Parameterized DML (single statement)

    static func run(db: OpaquePointer, sql: String, values: [Any]) throws -> (changes: Int, lastInsertId: Int64) {
        if hasMultipleStatements(sql) {
            throw SQLiteError.prepare("SQL string must contain exactly one statement")
        }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
            throw SQLiteError.prepare(msg)
        }
        defer { sqlite3_finalize(stmt) }

        try bind(stmt: stmt, values: values)

        let before = totalChanges(db: db)
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "step failed"
            throw SQLiteError.execute(msg)
        }

        let changes = totalChanges(db: db) - before
        let inserted = SQLStatement.isInsertLike(sql) && changes > 0
        return (changes, inserted ? sqlite3_last_insert_rowid(db) : 0)
    }

    // MARK: - SELECT

    static func query(db: OpaquePointer, sql: String, values: [Any]) throws -> [[String: Any]] {
        if hasMultipleStatements(sql) {
            throw SQLiteError.prepare("SQL string must contain exactly one statement")
        }
        guard SQLStatement.isQueryResultStatement(sql) else {
            throw SQLiteError.prepare("'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING")
        }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
            throw SQLiteError.prepare(msg)
        }
        defer { sqlite3_finalize(stmt) }

        if !values.isEmpty {
            try bind(stmt: stmt, values: values)
        }

        return try fetchRows(stmt: stmt, db: db)
    }

    // MARK: - Transactions

    static func beginTransaction(db: OpaquePointer) throws {
        try exec(db: db, sql: "BEGIN TRANSACTION;")
    }

    static func commitTransaction(db: OpaquePointer) throws {
        try exec(db: db, sql: "COMMIT TRANSACTION;")
    }

    static func rollbackTransaction(db: OpaquePointer) throws {
        try exec(db: db, sql: "ROLLBACK TRANSACTION;")
    }

    // MARK: - PRAGMA helpers

    static func getUserVersion(db: OpaquePointer) throws -> Int {
        let rows = try query(db: db, sql: "PRAGMA user_version;", values: [])
        guard let val = rows.first?["user_version"] as? Int64 else { return 0 }
        return Int(val)
    }

    static func getSQLiteVersion(db: OpaquePointer) throws -> String {
        let rows = try query(db: db, sql: "SELECT sqlite_version() AS version;", values: [])
        return rows.first?["version"] as? String ?? ""
    }

    static func setUserVersion(db: OpaquePointer, version: Int) throws {
        // version is typed as Int (Swift), so no injection risk.
        try exec(db: db, sql: "PRAGMA user_version = \(version);")
    }

    static func totalChanges(db: OpaquePointer) -> Int {
        return Int(sqlite3_total_changes(db))
    }

    static func vacuum(db: OpaquePointer) throws {
        try exec(db: db, sql: "VACUUM;")
    }
}
// swiftlint:enable identifier_name
