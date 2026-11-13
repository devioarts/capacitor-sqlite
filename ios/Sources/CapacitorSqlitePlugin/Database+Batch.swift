import Foundation

private typealias BatchItem = (sql: String, values: SQLiteBindValues)

final class BatchDiagnostics {
    private(set) var timings: [String: Double] = [:]

    func set(_ key: String, nanos: UInt64) {
        timings[key] = Double(nanos) / 1_000_000.0
    }

    func set(_ key: String, start: UInt64, end: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        set(key, nanos: end - start)
    }

    func add(_ key: String, nanos: UInt64) {
        timings[key, default: 0] += Double(nanos) / 1_000_000.0
    }

    func add(_ key: String, start: UInt64, end: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        add(key, nanos: end - start)
    }
}

extension Database {
    func runBatchUnsafe(
        set: [[String: Any]],
        transaction: Bool,
        diagnostics: BatchDiagnostics? = nil
    ) throws -> (changes: Int, lastInsertId: Int64) {
        let totalStart = DispatchTime.now().uptimeNanoseconds
        let handle = try requireOpen("runBatch")
        try requireWritable("runBatch")
        let before = SQLiteHelpers.totalChanges(db: handle)
        let parseStart = DispatchTime.now().uptimeNanoseconds
        let parsed = try parseBatch(set: set)
        diagnostics?.set("dbParseMs", start: parseStart)
        diagnostics?.set("dbValidatePrepareMs", nanos: 0)

        if transaction {
            for item in parsed { try requireManagedTransactionStatement(item.sql) }
            try executeTransactionalBatch(parsed, handle: handle, diagnostics: diagnostics)
        } else {
            try executeAutocommitBatch(parsed, handle: handle, diagnostics: diagnostics)
        }
        diagnostics?.set("dbTotalMs", start: totalStart)
        return (SQLiteHelpers.totalChanges(db: handle) - before, 0)
    }

    private func executeTransactionalBatch(
        _ items: [BatchItem],
        handle: OpaquePointer,
        diagnostics: BatchDiagnostics?
    ) throws {
        let beginStart = DispatchTime.now().uptimeNanoseconds
        try beginTransactionUnsafe()
        diagnostics?.set("dbBeginMs", start: beginStart)
        do {
            try executeBatchItems(items, handle: handle, diagnostics: diagnostics)
            let commitStart = DispatchTime.now().uptimeNanoseconds
            try commitTransactionUnsafe()
            diagnostics?.set("dbCommitMs", start: commitStart)
        } catch {
            try? rollbackTransactionUnsafe()
            throw error
        }
    }

    private func executeAutocommitBatch(
        _ items: [BatchItem],
        handle: OpaquePointer,
        diagnostics: BatchDiagnostics?
    ) throws {
        try executeBatchItems(items, handle: handle, diagnostics: diagnostics)
        diagnostics?.set("dbCommitMs", nanos: 0)
    }

    private func executeBatchItems(
        _ items: [BatchItem],
        handle: OpaquePointer,
        diagnostics: BatchDiagnostics?
    ) throws {
        var statements: [Data: SQLiteHelpers.PreparedRunStatement] = [:]
        defer { statements.values.forEach { $0.close() } }
        do {
            let loopStart = DispatchTime.now().uptimeNanoseconds
            for item in items {
                let cacheable = ["INSERT", "UPDATE", "DELETE", "REPLACE"].contains(SQLStatement.type(item.sql))
                // SQLite distinguishes Unicode normalizations that Swift String equality merges.
                let cacheKey = Data(item.sql.utf8)
                let statement: SQLiteHelpers.PreparedRunStatement
                if let cached = statements[cacheKey] {
                    statement = cached
                } else {
                    let prepareStart = DispatchTime.now().uptimeNanoseconds
                    // Prepare in order: earlier DDL may create the schema, and PRAGMA can act during prepare.
                    statement = try SQLiteHelpers.PreparedRunStatement(
                        db: handle, sql: item.sql, normalizedValues: item.values, bindInitialValues: false
                    )
                    diagnostics?.add("dbPrepareUniqueMs", start: prepareStart)
                    if cacheable { statements[cacheKey] = statement }
                }
                // Re-preparing PRAGMA preserves effects on every occurrence (OFF, ON, OFF).
                defer { if !cacheable { statement.close() } }
                try statement.bindNormalizedPrevalidated(values: item.values, diagnostics: diagnostics)
                try statement.execute(diagnostics: diagnostics)
            }
            diagnostics?.set("dbExecuteLoopMs", start: loopStart)
        } catch SQLiteError.invalidParams(let message) {
            throw DatabaseError.invalidParams(message)
        } catch let error as SQLiteError {
            throw DatabaseError.run(error.message)
        }
    }

    private func parseBatch(set: [[String: Any]]) throws -> [BatchItem] {
        var parsed: [BatchItem] = []
        parsed.reserveCapacity(set.count)
        for item in set {
            guard let sql = item["statement"] as? String,
                  sql.containsNonWhitespace else {
                throw DatabaseError.invalidParams("runBatch: each item must have a non-empty 'statement' key")
            }
            if let values = item["values"], !(values is [Any]) {
                throw DatabaseError.invalidParams("runBatch: 'values' must be an array")
            }
            let rawValues = item["values"] as? [Any] ?? []
            do {
                let values = try SQLiteHelpers.normalizeBindValues(rawValues)
                // Validate every input without preparing SQL or changing connection state.
                try SQLiteHelpers.validateRunInput(sql: sql, valueCount: values.count)
                parsed.append((sql, values))
            } catch SQLiteError.invalidParams(let message) {
                throw DatabaseError.invalidParams(message)
            }
        }
        return parsed
    }

}

private extension String {
    var containsNonWhitespace: Bool {
        unicodeScalars.contains { !$0.properties.isWhitespace }
    }
}
