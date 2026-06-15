import Foundation
import SQLite3

enum DatabaseError: Error {
    case notOpen(String)
    case open(String)
    case close(String)
    case execute(String)
    case run(String)
    case query(String)
    case transaction(String)
    case migration(String)
}

struct MigrationEntry {
    let version: Int
    let statements: [String]
}

// swiftlint:disable:next type_body_length
final class Database {
    let name: String
    let path: String
    let readonly: Bool
    private var db: OpaquePointer? // swiftlint:disable:this identifier_name
    private var openState: Bool = false
    private var inTransaction: Bool = false
    // Serial queue serializes all ops including open/close — prevents all races.
    private let queue: DispatchQueue

    var isOpen: Bool {
        queue.sync { openState }
    }

    init(name: String, path: String, readonly: Bool = false) {
        self.name = name
        self.path = path
        self.readonly = readonly
        self.queue = DispatchQueue(label: "com.devioarts.capacitor.sqlite.\(name)", qos: .userInitiated)
    }

    // MARK: - Open / Close

    func open(migrations: [MigrationEntry] = []) throws {
        // Serialize open() on the queue — idempotent and race-safe.
        var openError: Error?
        queue.sync {
            guard !openState else { return }
            do {
                try openUnsafe(migrations: migrations)
            } catch {
                openError = error
            }
        }
        if let err = openError { throw err }
    }

    func close() throws {
        var closeError: Error?
        queue.sync {
            guard openState, let handle = db else { return }
            if inTransaction {
                try? SQLiteHelpers.rollbackTransaction(db: handle)
                inTransaction = false
            }
            do {
                try SQLiteHelpers.close(db: handle)
                db = nil
                openState = false
            } catch SQLiteError.close(let msg) {
                closeError = DatabaseError.close(msg)
            } catch {
                closeError = error
            }
        }
        if let err = closeError { throw err }
    }

    // MARK: - Execute (DDL / no-result DML, no params)

    func execute(statements: [String], transaction: Bool = true) throws -> Int {
        try queue.sync { try executeUnsafe(statements: statements, transaction: transaction) }
    }

    // MARK: - Run (single parameterized statement)

    func run(statement: String, values: [Any] = []) throws -> (changes: Int, lastInsertId: Int64) {
        try queue.sync { try runUnsafe(statement: statement, values: values) }
    }

    // MARK: - RunBatch

    func runBatch(set: [[String: Any]], transaction: Bool = true) throws -> (changes: Int, lastInsertId: Int64) {
        try queue.sync { try runBatchUnsafe(set: set, transaction: transaction) }
    }

    // MARK: - Query

    func query(statement: String, values: [Any] = []) throws -> [[String: Any]] {
        try queue.sync { try queryUnsafe(statement: statement, values: values) }
    }

    // MARK: - Version / Maintenance

    func getVersion() throws -> String {
        try queue.sync { try getVersionUnsafe() }
    }

    func getSchemaVersion() throws -> Int {
        try queue.sync { try getSchemaVersionUnsafe() }
    }

    func vacuum() throws {
        try queue.sync { try vacuumUnsafe() }
    }

    // MARK: - Transactions

    func beginTransaction() throws {
        try queue.sync { try beginTransactionUnsafe() }
    }

    func commitTransaction() throws {
        try queue.sync { try commitTransactionUnsafe() }
    }

    func rollbackTransaction() throws {
        try queue.sync { try rollbackTransactionUnsafe() }
    }

    // MARK: - Unsafe (must be called from queue)

    private func openUnsafe(migrations: [MigrationEntry]) throws {
        do {
            db = try SQLiteHelpers.open(path: path, readonly: readonly)
        } catch SQLiteError.open(let msg) {
            throw DatabaseError.open(msg)
        }
        do {
            openState = true

            guard !readonly else { return }

            if path != ":memory:" {
                try pragma("PRAGMA journal_mode = WAL;")
            }
            try pragma("PRAGMA foreign_keys = ON;")

            if !migrations.isEmpty {
                try runMigrationsUnsafe(migrations)
            }
        } catch {
            if let handle = db {
                sqlite3_close_v2(handle)
            }
            db = nil
            openState = false
            inTransaction = false
            throw error
        }
    }

    private func executeUnsafe(statements: [String], transaction: Bool) throws -> Int {
        let handle = try requireOpen("execute")
        try requireWritable("execute")
        let before = SQLiteHelpers.totalChanges(db: handle)
        if transaction { try beginTransactionUnsafe() }
        do {
            for sql in statements {
                let trimmed = sql.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { continue }
                try SQLiteHelpers.exec(db: handle, sql: trimmed)
            }
            if transaction { try commitTransactionUnsafe() }
        } catch SQLiteError.execute(let msg) {
            if transaction { try? rollbackTransactionUnsafe() }
            throw DatabaseError.execute(msg)
        } catch {
            if transaction { try? rollbackTransactionUnsafe() }
            throw error
        }
        return SQLiteHelpers.totalChanges(db: handle) - before
    }

    private func runUnsafe(statement: String, values: [Any]) throws -> (changes: Int, lastInsertId: Int64) {
        let handle = try requireOpen("run")
        try requireWritable("run")
        do {
            return try SQLiteHelpers.run(db: handle, sql: statement, values: values)
        } catch let err as SQLiteError {
            throw DatabaseError.run("\(err)")
        }
    }

    private func runBatchUnsafe(set: [[String: Any]], transaction: Bool) throws -> (changes: Int, lastInsertId: Int64) {
        let handle = try requireOpen("runBatch")
        try requireWritable("runBatch")
        let before = SQLiteHelpers.totalChanges(db: handle)

        if transaction { try beginTransactionUnsafe() }
        do {
            for item in set {
                guard let sql = item["statement"] as? String,
                      !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw DatabaseError.run("runBatch: each item must have a non-empty 'statement' key")
                }
                let vals = item["values"] as? [Any] ?? []
                _ = try SQLiteHelpers.run(db: handle, sql: sql, values: vals)
            }
            if transaction { try commitTransactionUnsafe() }
        } catch {
            if transaction { try? rollbackTransactionUnsafe() }
            throw DatabaseError.run("\(error)")
        }

        return (SQLiteHelpers.totalChanges(db: handle) - before, 0)
    }

    private func queryUnsafe(statement: String, values: [Any]) throws -> [[String: Any]] {
        let handle = try requireOpen("query")
        do {
            return try SQLiteHelpers.query(db: handle, sql: statement, values: values)
        } catch let err as SQLiteError {
            throw DatabaseError.query("\(err)")
        }
    }

    private func getVersionUnsafe() throws -> String {
        let handle = try requireOpen("getVersion")
        do {
            return try SQLiteHelpers.getSQLiteVersion(db: handle)
        } catch let err as SQLiteError {
            throw DatabaseError.query("\(err)")
        }
    }

    private func getSchemaVersionUnsafe() throws -> Int {
        let handle = try requireOpen("getSchemaVersion")
        do {
            return try SQLiteHelpers.getUserVersion(db: handle)
        } catch let err as SQLiteError {
            throw DatabaseError.query("\(err)")
        }
    }

    private func vacuumUnsafe() throws {
        let handle = try requireOpen("vacuum")
        try requireWritable("vacuum")
        do {
            try SQLiteHelpers.vacuum(db: handle)
        } catch SQLiteError.execute(let msg) {
            throw DatabaseError.execute(msg)
        }
    }

    private func beginTransactionUnsafe() throws {
        let handle = try requireOpen("beginTransaction")
        try requireWritable("beginTransaction")
        guard !inTransaction else {
            throw DatabaseError.transaction("beginTransaction: a transaction is already active on '\(name)'")
        }
        do {
            try SQLiteHelpers.beginTransaction(db: handle)
            inTransaction = true
        } catch SQLiteError.execute(let msg) {
            throw DatabaseError.transaction(msg)
        }
    }

    private func commitTransactionUnsafe() throws {
        let handle = try requireOpen("commitTransaction")
        do {
            try SQLiteHelpers.commitTransaction(db: handle)
            inTransaction = false
        } catch SQLiteError.execute(let msg) {
            throw DatabaseError.transaction(msg)
        }
    }

    private func rollbackTransactionUnsafe() throws {
        let handle = try requireOpen("rollbackTransaction")
        do {
            try SQLiteHelpers.rollbackTransaction(db: handle)
            inTransaction = false
        } catch SQLiteError.execute(let msg) {
            throw DatabaseError.transaction(msg)
        }
    }

    // MARK: - Migrations (called from openUnsafe, already on queue)

    private func runMigrationsUnsafe(_ migrations: [MigrationEntry]) throws {
        guard let handle = db else { return }

        let current: Int
        do {
            current = try SQLiteHelpers.getUserVersion(db: handle)
        } catch {
            throw DatabaseError.migration("Cannot read user_version: \(error)")
        }

        let pending = migrations
            .filter { $0.version > current }
            .sorted { $0.version < $1.version }

        guard !pending.isEmpty else { return }

        for migration in pending {
            do {
                try SQLiteHelpers.beginTransaction(db: handle)
                for sql in migration.statements {
                    let trimmed = sql.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { continue }
                    try SQLiteHelpers.exec(db: handle, sql: trimmed)
                }
                try SQLiteHelpers.setUserVersion(db: handle, version: migration.version)
                try SQLiteHelpers.commitTransaction(db: handle)
            } catch {
                try? SQLiteHelpers.rollbackTransaction(db: handle)
                throw DatabaseError.migration("Migration v\(migration.version) failed: \(error)")
            }
        }
    }

    // MARK: - Private helpers

    private func requireOpen(_ context: String) throws -> OpaquePointer {
        guard openState, let handle = db else {
            throw DatabaseError.notOpen("\(context): '\(name)' is not open")
        }
        return handle
    }

    private func requireWritable(_ context: String) throws {
        guard !readonly else {
            throw DatabaseError.execute("\(context): database '\(name)' is open in readonly mode")
        }
    }

    // Called only from within the queue (openUnsafe), so no extra sync needed.
    private func pragma(_ sql: String) throws {
        guard let handle = db else { return }
        do {
            try SQLiteHelpers.exec(db: handle, sql: sql)
        } catch SQLiteError.execute(let msg) {
            throw DatabaseError.execute(msg)
        }
    }
}
