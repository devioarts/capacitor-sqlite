import Foundation

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

        if transaction { try requireManagedTransactionStatement(sql) }
        let normalizedValueSets = try validateRunManyValues(sql: sql, valueSets: valueSets)

        if transaction && inTransaction {
            throw DatabaseError.transaction("runMany: a transaction is already active on '\(name)'")
        }
        let before = SQLiteHelpers.totalChanges(db: handle)
        var results: [(changes: Int, lastInsertId: Int64)]? = returnResults ? [] : nil
        if transaction { try beginTransactionUnsafe() }
        do {
            // Even preparation of PRAGMA must happen inside the transaction we own.
            let prepared = try SQLiteHelpers.PreparedRunStatement(
                db: handle, sql: sql, normalizedValues: normalizedValueSets[0], bindInitialValues: false
            )
            defer { prepared.close() }
            for values in normalizedValueSets {
                try prepared.bindNormalizedPrevalidated(values: values)
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
            if transaction { try? rollbackTransactionUnsafe() }
            throw DatabaseError.run("\(error)")
        }
    }

    private func validateRunManyValues(sql: String, valueSets: [[Any]]) throws -> [SQLiteBindValues] {
        do {
            let normalized = try valueSets.map(SQLiteHelpers.normalizeBindValues)
            for values in normalized { try SQLiteHelpers.validateRunInput(sql: sql, valueCount: values.count) }
            return normalized
        } catch SQLiteError.invalidParams(let message) {
            throw DatabaseError.invalidParams(message)
        } catch {
            throw DatabaseError.run("runMany validation failed: \(error)")
        }
    }
}
