import Foundation
import SQLite3

extension Database {
    // Validation, transaction state, optional per-item metadata, and two error
    // domains intentionally meet here so every path shares one rollback policy.
    // swiftlint:disable:next cyclomatic_complexity
    func runManyUnsafe(
        statement sql: String,
        valueSets: [[Any]],
        transaction: Bool,
        returnResults: Bool
    ) throws -> (changes: Int, results: [(changes: Int, lastInsertId: Int64)]?) {
        let handle = try requireOpen("runMany")
        try requireWritable("runMany")
        guard !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DatabaseError.invalidParams("runMany: 'statement' is required")
        }
        guard !valueSets.isEmpty else {
            throw DatabaseError.invalidParams("runMany: 'values' must be a non-empty array of value arrays")
        }

        let prepared: SQLiteHelpers.PreparedRunStatement
        do {
            prepared = try SQLiteHelpers.PreparedRunStatement(
                db: handle,
                sql: sql,
                values: valueSets[0],
                bindInitialValues: false
            )
            // Validate every bind before the first write.
            for values in valueSets { try prepared.validate(values: values) }
        } catch SQLiteError.invalidParams(let message) {
            throw DatabaseError.invalidParams(message)
        } catch {
            throw DatabaseError.run("runMany validation failed: \(error)")
        }
        defer { prepared.close() }

        if transaction && inTransaction {
            throw DatabaseError.transaction("runMany: a transaction is already active on '\(name)'")
        }
        let before = SQLiteHelpers.totalChanges(db: handle)
        var results: [(changes: Int, lastInsertId: Int64)]? = returnResults ? [] : nil
        if transaction { try beginTransactionUnsafe() }
        do {
            for values in valueSets {
                try prepared.bind(values: values)
                if returnResults {
                    results?.append(try prepared.executeWithMetadata())
                } else {
                    try prepared.execute()
                }
            }
            let changes = SQLiteHelpers.totalChanges(db: handle) - before
            if transaction { try commitTransactionUnsafe() }
            return (changes, results)
        } catch SQLiteError.invalidParams(let message) {
            if transaction { try? rollbackTransactionUnsafe() }
            throw DatabaseError.invalidParams(message)
        } catch {
            inTransaction = sqlite3_get_autocommit(handle) == 0
            if transaction { try? rollbackTransactionUnsafe() }
            throw DatabaseError.run("\(error)")
        }
    }
}
