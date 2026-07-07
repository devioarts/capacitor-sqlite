import Foundation

enum CapacitorSqliteError: Error {
    case failed(code: String, message: String)
}

final class CapacitorSqlite {
    var databases: [String: Database] = [:]
    // Serializes dictionary mutations; Database.open/close use their own internal queue.
    let lock = NSLock()

    // MARK: - isAvailable

    func isAvailable() -> Bool { true }

    // MARK: - open

    func open(database: String, readonly: Bool, migrations: [[String: Any]], directory: String? = nil) throws {
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

    func closeAll() {
        let instances: [Database] = {
            lock.lock()
            defer { lock.unlock() }
            let values = Array(databases.values)
            databases.removeAll()
            return values
        }()
        for instance in instances {
            try? instance.close()
        }
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

    @discardableResult
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

}
