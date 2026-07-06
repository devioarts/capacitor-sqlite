import Foundation

enum CapacitorSqliteError: Error {
    case failed(code: String, message: String)
}

final class CapacitorSqlite {
    private var databases: [String: Database] = [:]
    // Serializes dictionary mutations; Database.open/close use their own internal queue.
    private let lock = NSLock()

    // MARK: - isAvailable

    func isAvailable() -> Bool { true }

    // MARK: - open

    func open(database: String, readonly: Bool, directory: String? = nil, migrations: [[String: Any]]) throws {
        guard database == ":memory:" || database.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            throw CapacitorSqliteError.failed(
                code: "INVALID_NAME",
                message: "Invalid database name '\(database)'. Use only A-Z, a-z, 0-9, _ or -"
            )
        }
        let key = databaseKey(database)
        let path = database == ":memory:" ? ":memory:" : try databasePath(name: database, directory: directory)
        // Throws on malformed entries — no silent drops.
        let entries = try parseMigrations(migrations)
        if readonly && !entries.isEmpty {
            throw CapacitorSqliteError.failed(code: "MIGRATION_FAILED", message: "Migrations cannot run when readonly is true")
        }

        // Atomically get-or-create the Database instance under lock.
        // Storing before open() ensures concurrent callers share the same instance,
        // and Database.open() is idempotent (serialized by its own DispatchQueue).
        let instance: Database? = {
            lock.lock()
            defer { lock.unlock() }
            if let existing = databases[key] {
                guard existing.readonly == readonly && sameDatabasePath(existing.path, path) else {
                    return nil
                }
                return existing
            }
            let newInstance = Database(name: database, path: path, readonly: readonly)
            databases[key] = newInstance
            return newInstance
        }()
        guard let instance else {
            throw CapacitorSqliteError.failed(
                code: "DB_ALREADY_OPEN",
                message: "open: '\(database)' is already open with a different readonly mode or directory"
            )
        }

        do {
            try instance.open(migrations: entries)
        } catch {
            removeFailedOpen(key: key, instance: instance)
            throw mapError(error, fallback: "OPEN_FAILED")
        }
    }

    // MARK: - close

    func close(database: String) throws {
        let instance: Database? = {
            lock.lock()
            defer { lock.unlock() }
            return databases[databaseKey(database)]
        }()
        guard let instance else {
            throw CapacitorSqliteError.failed(code: "DB_NOT_OPEN", message: "close: '\(database)' is not open")
        }
        do {
            try instance.close()
        } catch {
            throw mapError(error, fallback: "CLOSE_FAILED")
        }
        lock.lock(); databases.removeValue(forKey: databaseKey(database)); lock.unlock()
    }

    // MARK: - isOpen

    func isOpen(database: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return databases[databaseKey(database)]?.isOpen ?? false
    }

    // MARK: - getVersion

    func getVersion(database: String) throws -> String {
        let inst = try requireOpen(database, context: "getVersion")
        do {
            return try inst.getVersion()
        } catch {
            throw mapError(error, fallback: "VERSION_FAILED")
        }
    }

    // MARK: - getSchemaVersion

    func getSchemaVersion(database: String) throws -> Int {
        let inst = try requireOpen(database, context: "getSchemaVersion")
        do {
            return try inst.getSchemaVersion()
        } catch {
            throw mapError(error, fallback: "SCHEMA_VERSION_FAILED")
        }
    }

    // MARK: - vacuum

    func vacuum(database: String) throws {
        let inst = try requireOpen(database, context: "vacuum")
        do {
            try inst.vacuum()
        } catch {
            throw mapError(error, fallback: "VACUUM_FAILED")
        }
    }

    // MARK: - execute

    func execute(database: String, statements: [String], transaction: Bool = true) throws -> Int {
        let inst = try requireOpen(database, context: "execute")
        do {
            return try inst.execute(statements: statements, transaction: transaction)
        } catch {
            throw mapError(error, fallback: "EXECUTE_FAILED")
        }
    }

    // MARK: - run

    func run(database: String, statement: String, values: [Any]) throws -> (changes: Int, lastInsertId: Int64) {
        let inst = try requireOpen(database, context: "run")
        do {
            return try inst.run(statement: statement, values: values)
        } catch {
            throw mapError(error, fallback: "EXECUTE_FAILED")
        }
    }

    // MARK: - runBatch

    func runBatch(database: String, set: [[String: Any]], transaction: Bool) throws -> (changes: Int, lastInsertId: Int64) {
        let inst = try requireOpen(database, context: "runBatch")
        do {
            return try inst.runBatch(set: set, transaction: transaction)
        } catch {
            throw mapError(error, fallback: "EXECUTE_FAILED")
        }
    }

    // MARK: - query

    func query(database: String, statement: String, values: [Any]) throws -> [[String: Any]] {
        let inst = try requireOpen(database, context: "query")
        do {
            return try inst.query(statement: statement, values: values)
        } catch {
            throw mapError(error, fallback: "QUERY_FAILED")
        }
    }

    // MARK: - transactions

    func beginTransaction(database: String) throws {
        let inst = try requireOpen(database, context: "beginTransaction")
        do {
            try inst.beginTransaction()
        } catch {
            throw mapError(error, fallback: "TRANSACTION_FAILED")
        }
    }

    func commitTransaction(database: String) throws {
        let inst = try requireOpen(database, context: "commitTransaction")
        do {
            try inst.commitTransaction()
        } catch {
            throw mapError(error, fallback: "TRANSACTION_FAILED")
        }
    }

    func rollbackTransaction(database: String) throws {
        let inst = try requireOpen(database, context: "rollbackTransaction")
        do {
            try inst.rollbackTransaction()
        } catch {
            throw mapError(error, fallback: "TRANSACTION_FAILED")
        }
    }

    // MARK: - Private helpers

    private func requireOpen(_ name: String, context: String) throws -> Database {
        // Read the Database instance under lock (dictionary access only).
        // isOpen calls queue.sync internally — do NOT hold lock during that call,
        // or a busy queue on DB-A would hold the global lock and starve DB-B.
        let inst: Database?
        lock.lock()
        inst = databases[databaseKey(name)]
        lock.unlock()
        guard let inst, inst.isOpen else {
            throw CapacitorSqliteError.failed(code: "DB_NOT_OPEN", message: "\(context): '\(name)' is not open")
        }
        return inst
    }

    private func removeFailedOpen(key: String, instance: Database) {
        lock.lock()
        defer { lock.unlock() }
        // Only remove the instance that failed. A concurrent retry may already
        // have replaced the map entry after the failed open released its queue.
        if databases[key] === instance && !instance.isOpen {
            databases.removeValue(forKey: key)
        }
    }

    private func databaseKey(_ name: String) -> String {
        name == ":memory:" ? name : name.lowercased()
    }

    private func sameDatabasePath(_ lhs: String, _ rhs: String) -> Bool {
        lhs == rhs || lhs.lowercased() == rhs.lowercased()
    }

    private func databasePath(name: String, directory: String? = nil) throws -> String {
        let fileManager = FileManager.default
        let base: URL
        // Keep this mapping aligned with OpenOptions.directory documentation.
        // Raw paths are intentionally not accepted across the bridge.
        switch directory ?? "default" {
        case "default", "library":
            base = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
        case "documents":
            guard let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first else {
                throw CapacitorSqliteError.failed(code: "OPEN_FAILED", message: "Cannot resolve Documents directory")
            }
            base = docs
        case "cache":
            guard let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
                throw CapacitorSqliteError.failed(code: "OPEN_FAILED", message: "Cannot resolve Caches directory")
            }
            base = caches
        default:
            throw CapacitorSqliteError.failed(
                code: "INVALID_PARAMS",
                message: "Invalid directory '\(directory ?? "")'. Use default, documents, library or cache"
            )
        }
        let dir = base.appendingPathComponent("CapacitorSQLite", isDirectory: true)
        if !fileManager.fileExists(atPath: dir.path) {
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent("\(name).db").path
    }

    /// Parses migration definitions; throws on any malformed entry instead of silently dropping it.
    private func parseMigrations(_ raw: [[String: Any]]) throws -> [MigrationEntry] {
        var seenVersions = Set<Int>()
        return try raw.enumerated().map { (idx, item) in
            guard let version = item["version"] as? Int, version > 0 else {
                throw CapacitorSqliteError.failed(
                    code: "MIGRATION_FAILED",
                    message: "Migration at index \(idx): 'version' must be a positive integer"
                )
            }
            guard seenVersions.insert(version).inserted else {
                throw CapacitorSqliteError.failed(
                    code: "MIGRATION_FAILED",
                    message: "Migration at index \(idx): duplicate version \(version)"
                )
            }
            guard let statements = item["statements"] as? [String], !statements.isEmpty else {
                throw CapacitorSqliteError.failed(
                    code: "MIGRATION_FAILED",
                    message: "Migration at index \(idx): 'statements' must be a non-empty [String]"
                )
            }
            guard statements.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                throw CapacitorSqliteError.failed(
                    code: "MIGRATION_FAILED",
                    message: "Migration at index \(idx): 'statements' entries must be non-empty strings"
                )
            }
            return MigrationEntry(version: version, statements: statements)
        }
    }

    private func mapError(_ error: Error, fallback: String) -> CapacitorSqliteError {
        switch error {
        case let err as CapacitorSqliteError:
            return err
        case DatabaseError.notOpen(let message):
            return .failed(code: "DB_NOT_OPEN", message: message)
        case DatabaseError.transaction(let message):
            return .failed(code: "TRANSACTION_FAILED", message: message)
        case DatabaseError.migration(let message):
            return .failed(code: "MIGRATION_FAILED", message: message)
        case DatabaseError.open(let message),
             DatabaseError.close(let message),
             DatabaseError.execute(let message),
             DatabaseError.run(let message),
             DatabaseError.query(let message):
            return .failed(code: fallback, message: message)
        default:
            return .failed(code: fallback, message: "\(error)")
        }
    }
}
