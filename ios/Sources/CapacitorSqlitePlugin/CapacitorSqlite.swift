import Foundation

enum CapacitorSqliteError: Error {
    case failed(message: String)
}

final class CapacitorSqlite {
    private var databases: [String: Database] = [:]
    // Serializes dictionary mutations; Database.open/close use their own internal queue.
    private let lock = NSLock()

    // MARK: - isAvailable

    func isAvailable() -> Bool { true }

    // MARK: - open

    func open(database: String, readonly: Bool, migrations: [[String: Any]]) throws {
        guard database == ":memory:" || database.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            throw CapacitorSqliteError.failed(message: "Invalid database name '\(database)'. Use only A–Z, a–z, 0–9, _ or -")
        }
        let path = database == ":memory:" ? ":memory:" : try databasePath(name: database)
        // Throws on malformed entries — no silent drops.
        let entries = try parseMigrations(migrations)

        // Atomically get-or-create the Database instance under lock.
        // Storing before open() ensures concurrent callers share the same instance,
        // and Database.open() is idempotent (serialized by its own DispatchQueue).
        let instance: Database? = {
            lock.lock()
            defer { lock.unlock() }
            if let existing = databases[database] {
                guard existing.readonly == readonly else {
                    return nil
                }
                return existing
            }
            let newInstance = Database(name: database, path: path, readonly: readonly)
            databases[database] = newInstance
            return newInstance
        }()
        guard let instance else {
            throw CapacitorSqliteError.failed(
                message: "open: '\(database)' is already open with a different readonly mode"
            )
        }

        do {
            try instance.open(migrations: entries)
        } catch DatabaseError.open(let msg) {
            // Remove from map so a retry can create a fresh instance.
            lock.lock(); databases.removeValue(forKey: database); lock.unlock()
            throw CapacitorSqliteError.failed(message: msg)
        } catch DatabaseError.migration(let msg) {
            lock.lock(); databases.removeValue(forKey: database); lock.unlock()
            throw CapacitorSqliteError.failed(message: msg)
        } catch {
            lock.lock(); databases.removeValue(forKey: database); lock.unlock()
            throw CapacitorSqliteError.failed(message: "open: \(error)")
        }
    }

    // MARK: - close

    func close(database: String) throws {
        let instance: Database? = {
            lock.lock()
            defer { lock.unlock() }
            return databases[database]
        }()
        guard let instance else {
            throw CapacitorSqliteError.failed(message: "close: '\(database)' is not open")
        }
        do {
            try instance.close()
        } catch DatabaseError.close(let msg) {
            throw CapacitorSqliteError.failed(message: msg)
        }
        lock.lock(); databases.removeValue(forKey: database); lock.unlock()
    }

    // MARK: - isOpen

    func isOpen(database: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return databases[database]?.isOpen ?? false
    }

    // MARK: - getVersion

    func getVersion(database: String) throws -> String {
        let inst = try requireOpen(database, context: "getVersion")
        do {
            return try inst.getVersion()
        } catch DatabaseError.query(let msg) {
            throw CapacitorSqliteError.failed(message: "getVersion: \(msg)")
        }
    }

    // MARK: - getSchemaVersion

    func getSchemaVersion(database: String) throws -> Int {
        let inst = try requireOpen(database, context: "getSchemaVersion")
        do {
            return try inst.getSchemaVersion()
        } catch DatabaseError.query(let msg) {
            throw CapacitorSqliteError.failed(message: "getSchemaVersion: \(msg)")
        }
    }

    // MARK: - vacuum

    func vacuum(database: String) throws {
        let inst = try requireOpen(database, context: "vacuum")
        do {
            try inst.vacuum()
        } catch DatabaseError.execute(let msg) {
            throw CapacitorSqliteError.failed(message: "vacuum: \(msg)")
        }
    }

    // MARK: - execute

    func execute(database: String, statements: [String], transaction: Bool = true) throws -> Int {
        let inst = try requireOpen(database, context: "execute")
        do {
            return try inst.execute(statements: statements, transaction: transaction)
        } catch DatabaseError.execute(let msg) {
            throw CapacitorSqliteError.failed(message: "execute: \(msg)")
        } catch DatabaseError.transaction(let msg) {
            throw CapacitorSqliteError.failed(message: "execute: \(msg)")
        }
    }

    // MARK: - run

    func run(database: String, statement: String, values: [Any]) throws -> (changes: Int, lastInsertId: Int64) {
        let inst = try requireOpen(database, context: "run")
        do {
            return try inst.run(statement: statement, values: values)
        } catch DatabaseError.run(let msg) {
            throw CapacitorSqliteError.failed(message: "run: \(msg)")
        }
    }

    // MARK: - runBatch

    func runBatch(database: String, set: [[String: Any]], transaction: Bool) throws -> (changes: Int, lastInsertId: Int64) {
        let inst = try requireOpen(database, context: "runBatch")
        do {
            return try inst.runBatch(set: set, transaction: transaction)
        } catch DatabaseError.run(let msg) {
            throw CapacitorSqliteError.failed(message: "runBatch: \(msg)")
        }
    }

    // MARK: - query

    func query(database: String, statement: String, values: [Any]) throws -> [[String: Any]] {
        let inst = try requireOpen(database, context: "query")
        do {
            return try inst.query(statement: statement, values: values)
        } catch DatabaseError.query(let msg) {
            throw CapacitorSqliteError.failed(message: "query: \(msg)")
        }
    }

    // MARK: - transactions

    func beginTransaction(database: String) throws {
        let inst = try requireOpen(database, context: "beginTransaction")
        do {
            try inst.beginTransaction()
        } catch DatabaseError.transaction(let msg) {
            throw CapacitorSqliteError.failed(message: "beginTransaction: \(msg)")
        }
    }

    func commitTransaction(database: String) throws {
        let inst = try requireOpen(database, context: "commitTransaction")
        do {
            try inst.commitTransaction()
        } catch DatabaseError.transaction(let msg) {
            throw CapacitorSqliteError.failed(message: "commitTransaction: \(msg)")
        }
    }

    func rollbackTransaction(database: String) throws {
        let inst = try requireOpen(database, context: "rollbackTransaction")
        do {
            try inst.rollbackTransaction()
        } catch DatabaseError.transaction(let msg) {
            throw CapacitorSqliteError.failed(message: "rollbackTransaction: \(msg)")
        }
    }

    // MARK: - Private helpers

    private func requireOpen(_ name: String, context: String) throws -> Database {
        lock.lock()
        let inst = databases[name]
        let open = inst?.isOpen ?? false
        lock.unlock()
        guard let inst, open else {
            throw CapacitorSqliteError.failed(message: "\(context): '\(name)' is not open")
        }
        return inst
    }

    private func databasePath(name: String) throws -> String {
        let fileManager = FileManager.default
        guard let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
            throw CapacitorSqliteError.failed(message: "Cannot resolve Documents directory")
        }
        let dir = docs.appendingPathComponent("CapacitorSQLite", isDirectory: true)
        if !fileManager.fileExists(atPath: dir.path) {
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent("\(name).db").path
    }

    /// Parses migration definitions; throws on any malformed entry instead of silently dropping it.
    private func parseMigrations(_ raw: [[String: Any]]) throws -> [MigrationEntry] {
        try raw.enumerated().map { (idx, item) in
            guard let version = item["version"] as? Int, version > 0 else {
                throw CapacitorSqliteError.failed(message: "Migration at index \(idx): 'version' must be a positive integer")
            }
            guard let statements = item["statements"] as? [String], !statements.isEmpty else {
                throw CapacitorSqliteError.failed(message: "Migration at index \(idx): 'statements' must be a non-empty [String]")
            }
            guard statements.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                throw CapacitorSqliteError.failed(message: "Migration at index \(idx): 'statements' entries must be non-empty strings")
            }
            return MigrationEntry(version: version, statements: statements)
        }
    }
}
