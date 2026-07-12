// swiftlint:disable identifier_name
import Foundation
import SQLite3

enum SQLiteError: Error {
    case invalidParams(String)
    case open(String)
    case close(String)
    case execute(String)
    case prepare(String)
    case query(String)
    case version(String)
}

enum SQLiteHelpers {
    final class PreparedRunStatement {
        private let db: OpaquePointer
        private let insertLike: Bool
        private let conflictClause: Bool
        private var statement: OpaquePointer?

        init(db: OpaquePointer, sql: String, values: [Any], bindInitialValues: Bool = true) throws {
            self.db = db
            self.insertLike = SQLStatement.isInsertLike(sql)
            self.conflictClause = SQLStatement.hasConflictClause(sql)
            if SQLiteHelpers.hasMultipleStatements(sql) {
                throw SQLiteError.invalidParams("SQL string must contain exactly one statement")
            }
            var prepared: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &prepared, nil) == SQLITE_OK else {
                let message = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
                throw SQLiteError.prepare(message)
            }
            statement = prepared
            do {
                if bindInitialValues {
                    try bind(values: values)
                } else {
                    try validate(values: values)
                }
            } catch {
                close()
                throw error
            }
        }

        init(
            db: OpaquePointer,
            sql: String,
            normalizedValues: SQLiteBindValues,
            bindInitialValues: Bool = true
        ) throws {
            self.db = db
            self.insertLike = SQLStatement.isInsertLike(sql)
            self.conflictClause = SQLStatement.hasConflictClause(sql)
            if SQLiteHelpers.hasMultipleStatements(sql) {
                throw SQLiteError.invalidParams("SQL string must contain exactly one statement")
            }
            var prepared: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &prepared, nil) == SQLITE_OK else {
                let message = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
                throw SQLiteError.prepare(message)
            }
            statement = prepared
            do {
                if bindInitialValues {
                    try bindNormalized(values: normalizedValues)
                } else {
                    try validate(normalizedValues: normalizedValues)
                }
            } catch {
                close()
                throw error
            }
        }

        func validate(values: [Any]) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            try SQLiteHelpers.validateBindValues(stmt: statement, values: values)
        }

        func validate(normalizedValues: SQLiteBindValues) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            try SQLiteHelpers.validateNormalizedBindValues(stmt: statement, values: normalizedValues)
        }

        func bind(values: [Any]) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            let resetCode = sqlite3_reset(statement)
            guard resetCode == SQLITE_OK else {
                let db = sqlite3_db_handle(statement)
                let message = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "reset failed"
                throw SQLiteError.execute(message)
            }
            sqlite3_clear_bindings(statement)
            try SQLiteHelpers.bind(stmt: statement, values: values)
        }

        func bindNormalized(values: SQLiteBindValues) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            let resetCode = sqlite3_reset(statement)
            guard resetCode == SQLITE_OK else {
                let db = sqlite3_db_handle(statement)
                let message = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "reset failed"
                throw SQLiteError.execute(message)
            }
            try SQLiteHelpers.bindNormalized(stmt: statement, values: values)
        }

        /// Binds values that were already validated during batch preflight.
        ///
        /// Transactional `runBatch()` validates every item before the first write so a
        /// later bind-count/type error cannot leave a partially-applied batch. The hot
        /// execution loop can therefore skip the duplicate validation work here and only
        /// do the SQLite reset + bind calls needed for this specific iteration.
        func bindPrevalidated(values: [Any], diagnostics: BatchDiagnostics? = nil) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            let resetStart = DispatchTime.now().uptimeNanoseconds
            let resetCode = sqlite3_reset(statement)
            diagnostics?.add("dbResetMs", start: resetStart)
            guard resetCode == SQLITE_OK else {
                let db = sqlite3_db_handle(statement)
                let message = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "reset failed"
                throw SQLiteError.execute(message)
            }
            let bindStart = DispatchTime.now().uptimeNanoseconds
            try SQLiteHelpers.bindPrevalidated(stmt: statement, values: values)
            diagnostics?.add("dbBindValuesMs", start: bindStart)
        }

        func bindNormalizedPrevalidated(values: SQLiteBindValues, diagnostics: BatchDiagnostics? = nil) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            let resetStart = DispatchTime.now().uptimeNanoseconds
            let resetCode = sqlite3_reset(statement)
            diagnostics?.add("dbResetMs", start: resetStart)
            guard resetCode == SQLITE_OK else {
                let db = sqlite3_db_handle(statement)
                let message = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "reset failed"
                throw SQLiteError.execute(message)
            }
            let bindStart = DispatchTime.now().uptimeNanoseconds
            try SQLiteHelpers.bindNormalizedPrevalidated(stmt: statement, values: values)
            diagnostics?.add("dbBindValuesMs", start: bindStart)
        }

        func execute(diagnostics: BatchDiagnostics? = nil) throws {
            guard let statement else { throw SQLiteError.prepare("statement is closed") }
            let stepStart = DispatchTime.now().uptimeNanoseconds
            let result = sqlite3_step(statement)
            diagnostics?.add("dbStepMs", start: stepStart)
            guard result == SQLITE_DONE || result == SQLITE_ROW else {
                let db = sqlite3_db_handle(statement)
                let message = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "step failed"
                throw SQLiteError.execute(message)
            }
        }

        func executeWithMetadata() throws -> (changes: Int, lastInsertId: Int64) {
            let beforeChanges = SQLiteHelpers.totalChanges(db: db)
            let beforeId = sqlite3_last_insert_rowid(db)
            try execute()
            let changes = SQLiteHelpers.totalChanges(db: db) - beforeChanges
            let currentId = sqlite3_last_insert_rowid(db)
            let reliable = insertLike && !conflictClause && changes > 0 && currentId != beforeId
            return (changes, reliable ? currentId : 0)
        }

        func close() {
            if let statement { sqlite3_finalize(statement) }
            statement = nil
        }

        deinit { close() }
    }

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
            throw SQLiteError.invalidParams("SQL string must contain exactly one statement")
        }
        if sqlite3_exec(db, sql, nil, nil, nil) != SQLITE_OK {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "exec failed"
            throw SQLiteError.execute(msg)
        }
    }

    // MARK: - Parameterized DML (single statement)

    static func run(db: OpaquePointer, sql: String, values: [Any]) throws -> (changes: Int, lastInsertId: Int64) {
        if hasMultipleStatements(sql) {
            throw SQLiteError.invalidParams("SQL string must contain exactly one statement")
        }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
            throw SQLiteError.prepare(msg)
        }
        defer { sqlite3_finalize(stmt) }

        try bind(stmt: stmt, values: values)

        let before = totalChanges(db: db)
        let beforeInsertId = sqlite3_last_insert_rowid(db)
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "step failed"
            throw SQLiteError.execute(msg)
        }

        let changes = totalChanges(db: db) - before
        // An UPSERT resolved via its DO UPDATE arm leaves last_insert_rowid() pointing at
        // the connection's last real insert, not this statement's affected row.
        let currentInsertId = sqlite3_last_insert_rowid(db)
        let inserted = SQLStatement.isInsertLike(sql)
            && changes > 0
            && !SQLStatement.hasConflictClause(sql)
            && currentInsertId != beforeInsertId
        return (changes, inserted ? currentInsertId : 0)
    }

    /// Prepares and binds without stepping, used to validate an entire batch
    /// before transaction:false can persist any early item.
    static func validateRunStatement(db: OpaquePointer, sql: String, values: [Any]) throws {
        let statement = try PreparedRunStatement(db: db, sql: sql, values: values)
        statement.close()
    }

    // MARK: - SELECT

    static func query(db: OpaquePointer, sql: String, values: [Any]) throws -> [[String: Any]] {
        let stmt = try prepareQuery(db: db, sql: sql, values: values)
        defer { sqlite3_finalize(stmt) }
        return try fetchRows(stmt: stmt, db: db)
    }

    static func queryCompact(db: OpaquePointer, sql: String, values: [Any]) throws -> CompactRows {
        let stmt = try prepareQuery(db: db, sql: sql, values: values)
        defer { sqlite3_finalize(stmt) }
        return try fetchCompactRows(stmt: stmt, db: db)
    }

    private static func prepareQuery(db: OpaquePointer, sql: String, values: [Any]) throws -> OpaquePointer? {
        if hasMultipleStatements(sql) {
            throw SQLiteError.invalidParams("SQL string must contain exactly one statement")
        }
        guard SQLStatement.isQueryResultStatement(sql) else {
            throw SQLiteError.prepare("'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING")
        }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "prepare failed"
            throw SQLiteError.prepare(msg)
        }
        // Always validate the count, including the important "placeholder present,
        // empty values array" case. Skipping bind() for [] silently treated `?` as NULL.
        try bind(stmt: stmt, values: values)
        return stmt
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
        // The 32-bit sqlite3_total_changes() wraps on very long-lived/high-write
        // connections. The 64-bit API keeps change counts correct past 2^31-1.
        if #available(iOS 15.4, *) {
            return Int(sqlite3_total_changes64(db))
        }
        return Int(sqlite3_total_changes(db))
    }

    static func vacuum(db: OpaquePointer) throws {
        try exec(db: db, sql: "VACUUM;")
    }
}
// swiftlint:enable identifier_name
