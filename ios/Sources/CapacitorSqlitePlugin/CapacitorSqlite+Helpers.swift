import Foundation

extension CapacitorSqlite {
    func requireOpen(_ name: String, context: String) throws -> Database {
        let inst: Database?
        lock.lock()
        inst = databases[databaseKey(name)]
        lock.unlock()
        guard let inst, inst.isOpen else {
            throw CapacitorSqliteError.failed(code: "DB_NOT_OPEN", message: "\(context): '\(name)' is not open")
        }
        return inst
    }

    func removeFailedOpen(key: String, instance: Database) {
        lock.lock()
        defer { lock.unlock() }
        if databases[key] === instance && !instance.isOpen {
            databases.removeValue(forKey: key)
        }
    }

    func databaseKey(_ name: String) -> String {
        name == ":memory:" ? name : name.lowercased()
    }

    func sameDatabasePath(_ lhs: String, _ rhs: String) -> Bool {
        lhs == rhs || lhs.lowercased() == rhs.lowercased()
    }

    func databasePath(name: String, directory: String? = nil) throws -> String {
        let fileManager = FileManager.default
        let base = try baseDirectory(fileManager: fileManager, directory: directory)
        let dir = base.appendingPathComponent("CapacitorSQLite", isDirectory: true)
        if !fileManager.fileExists(atPath: dir.path) {
            try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir.appendingPathComponent("\(name).db").path
    }

    func parseMigrations(_ raw: [[String: Any]]) throws -> [MigrationEntry] {
        var seenVersions = Set<Int>()
        return try raw.enumerated().map { (idx, item) in
            try parseMigration(item, index: idx, seenVersions: &seenVersions)
        }
    }

    func mapError(_ error: Error, fallback: String) -> CapacitorSqliteError {
        switch error {
        case let err as CapacitorSqliteError:
            return err
        // queryCompact() deliberately bypasses Database.queryUnsafe() so it can
        // return the compact column/value envelope. Preserve validation failures
        // raised by that direct SQLiteHelpers path instead of relabelling them as
        // QUERY_FAILED. Keeping this here also protects future direct helper paths.
        case SQLiteError.invalidParams(let message):
            return .failed(code: "INVALID_PARAMS", message: message)
        case DatabaseError.invalidParams(let message):
            return .failed(code: "INVALID_PARAMS", message: message)
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

    private func baseDirectory(fileManager: FileManager, directory: String?) throws -> URL {
        switch directory ?? "default" {
        case "default", "library":
            return try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
        case "documents":
            return try resolvedDirectory(fileManager: fileManager, directory: .documentDirectory, code: "OPEN_FAILED")
        case "cache":
            return try resolvedDirectory(fileManager: fileManager, directory: .cachesDirectory, code: "OPEN_FAILED")
        default:
            throw CapacitorSqliteError.failed(
                code: "INVALID_PARAMS",
                message: "Invalid directory '\(directory ?? "")'. Use default, documents, library or cache"
            )
        }
    }

    private func resolvedDirectory(
        fileManager: FileManager,
        directory: FileManager.SearchPathDirectory,
        code: String
    ) throws -> URL {
        guard let url = fileManager.urls(for: directory, in: .userDomainMask).first else {
            throw CapacitorSqliteError.failed(code: code, message: "Cannot resolve \(directory) directory")
        }
        return url
    }

    // SQLite's `PRAGMA user_version` is stored in a 32-bit signed field in the database
    // header, so this ceiling is shared by every backend (Android's Kotlin `Int` is
    // 32-bit and enforces the same limit) — not an arbitrary choice. Swift's `Int` is
    // 64-bit, so without this check a version above 2_147_483_647 would pass here and
    // then get silently truncated by SQLite itself when `setUserVersion` writes it.
    private static let maxMigrationVersion = 2_147_483_647

    private func parseMigration(
        _ item: [String: Any],
        index: Int,
        seenVersions: inout Set<Int>
    ) throws -> MigrationEntry {
        guard let version = item["version"] as? Int, version > 0, version <= Self.maxMigrationVersion else {
            throw CapacitorSqliteError.failed(
                code: "MIGRATION_FAILED",
                message: "Migration at index \(index): 'version' must be a positive integer between 1 and \(Self.maxMigrationVersion)"
            )
        }
        guard seenVersions.insert(version).inserted else {
            throw CapacitorSqliteError.failed(
                code: "MIGRATION_FAILED",
                message: "Migration at index \(index): duplicate version \(version)"
            )
        }
        let statements = try parseMigrationStatements(item, index: index)
        return MigrationEntry(version: version, statements: statements)
    }

    private func parseMigrationStatements(_ item: [String: Any], index: Int) throws -> [String] {
        guard let statements = item["statements"] as? [String], !statements.isEmpty else {
            throw CapacitorSqliteError.failed(
                code: "MIGRATION_FAILED",
                message: "Migration at index \(index): 'statements' must be a non-empty [String]"
            )
        }
        guard statements.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw CapacitorSqliteError.failed(
                code: "MIGRATION_FAILED",
                message: "Migration at index \(index): 'statements' entries must be non-empty strings"
            )
        }
        return statements
    }
}
