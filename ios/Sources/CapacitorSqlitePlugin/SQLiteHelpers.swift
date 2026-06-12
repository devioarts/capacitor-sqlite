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

// SQLITE_TRANSIENT tells SQLite to copy the string/blob before sqlite3_step returns.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLiteHelpers {

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
        if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "exec failed"
            throw SQLiteError.execute(msg)
        }
    }

    // MARK: - Parameterized DML (single statement)

    static func run(db: OpaquePointer, sql: String, values: [Any]) throws -> (changes: Int, lastInsertId: Int64) {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
            throw SQLiteError.prepare(msg)
        }
        defer { sqlite3_finalize(stmt) }

        try bind(stmt: stmt, values: values)

        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "step failed"
            throw SQLiteError.execute(msg)
        }

        let changes = Int(sqlite3_changes(db))
        let stmtType = sql.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
            .first?
            .uppercased() ?? ""
        let inserted = (stmtType == "INSERT" || stmtType == "REPLACE") && changes > 0
        return (changes, inserted ? sqlite3_last_insert_rowid(db) : 0)
    }

    // MARK: - SELECT

    static func query(db: OpaquePointer, sql: String, values: [Any]) throws -> [[String: Any]] {
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

    // MARK: - Private: bind

    private static func bind(stmt: OpaquePointer?, values: [Any]) throws {
        for (i, value) in values.enumerated() {
            try bindValue(stmt: stmt, value: value, idx: Int32(i + 1))
        }
    }

    private static func bindValue(stmt: OpaquePointer?, value: Any, idx: Int32) throws {
        switch value {
        case is NSNull:
            sqlite3_bind_null(stmt, idx)
        case let v as Double:
            sqlite3_bind_double(stmt, idx, v)
        case let v as Float:
            sqlite3_bind_double(stmt, idx, Double(v))
        case let v as Int64:
            sqlite3_bind_int64(stmt, idx, v)
        case let v as Int:
            sqlite3_bind_int64(stmt, idx, Int64(v))
        case let v as Bool:
            sqlite3_bind_int(stmt, idx, v ? 1 : 0)
        case let v as String:
            sqlite3_bind_text(stmt, idx, v, -1, SQLITE_TRANSIENT)
        case let v as Data:
            v.withUnsafeBytes { ptr in
                _ = sqlite3_bind_blob(stmt, idx, ptr.baseAddress, Int32(v.count), SQLITE_TRANSIENT)
            }
        case let v as [UInt8]:
            let d = Data(v)
            d.withUnsafeBytes { ptr in
                _ = sqlite3_bind_blob(stmt, idx, ptr.baseAddress, Int32(d.count), SQLITE_TRANSIENT)
            }
        default:
            throw SQLiteError.execute("Unsupported bind value type at index \(idx)")
        }
    }

    // MARK: - Private: fetch rows

    private static func fetchRows(stmt: OpaquePointer?, db: OpaquePointer) throws -> [[String: Any]] {
        var rows: [[String: Any]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else {
                let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "step failed"
                throw SQLiteError.query(msg)
            }
            rows.append(try readRow(stmt: stmt))
        }
        return rows
    }

    private static func readRow(stmt: OpaquePointer?) throws -> [String: Any] {
        let count = sqlite3_column_count(stmt)
        var row: [String: Any] = [:]
        for i in 0..<count {
            guard let namePtr = sqlite3_column_name(stmt, i) else {
                throw SQLiteError.query("column_name failed at index \(i)")
            }
            let name = String(cString: namePtr)
            switch sqlite3_column_type(stmt, i) {
            case SQLITE_INTEGER:
                row[name] = sqlite3_column_int64(stmt, i)
            case SQLITE_FLOAT:
                row[name] = sqlite3_column_double(stmt, i)
            case SQLITE_TEXT:
                row[name] = sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? NSNull()
            case SQLITE_BLOB:
                if let ptr = sqlite3_column_blob(stmt, i) {
                    row[name] = Array(Data(bytes: ptr, count: Int(sqlite3_column_bytes(stmt, i))))
                } else {
                    row[name] = NSNull()
                }
            case SQLITE_NULL:
                row[name] = NSNull()
            default:
                row[name] = NSNull()
            }
        }
        return row
    }
}
// swiftlint:enable identifier_name
