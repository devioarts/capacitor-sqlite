import Foundation
import SQLite3

private typealias BatchItem = (sql: String, rawValues: [Any], values: SQLiteBindValues)
private typealias PreparedBatchItem = (statement: SQLiteHelpers.PreparedRunStatement, values: SQLiteBindValues)

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

        if transaction {
            try executeTransactionalBatch(parsed, handle: handle, diagnostics: diagnostics)
        } else {
            let validateStart = DispatchTime.now().uptimeNanoseconds
            try validateBatch(parsed, handle: handle)
            diagnostics?.set("dbValidatePrepareMs", start: validateStart)
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
        let prepareStart = DispatchTime.now().uptimeNanoseconds
        let prepared = try prepareBatch(items, handle: handle, diagnostics: diagnostics)
        diagnostics?.set("dbValidatePrepareMs", start: prepareStart)
        defer { prepared.statements.values.forEach { $0.close() } }
        let beginStart = DispatchTime.now().uptimeNanoseconds
        try beginTransactionUnsafe()
        diagnostics?.set("dbBeginMs", start: beginStart)
        do {
            let loopStart = DispatchTime.now().uptimeNanoseconds
            for item in prepared.items {
                try item.statement.bindNormalizedPrevalidated(values: item.values, diagnostics: diagnostics)
                try item.statement.execute(diagnostics: diagnostics)
            }
            diagnostics?.set("dbExecuteLoopMs", start: loopStart)
            let commitStart = DispatchTime.now().uptimeNanoseconds
            try commitTransactionUnsafe()
            diagnostics?.set("dbCommitMs", start: commitStart)
        } catch SQLiteError.invalidParams(let message) {
            try? rollbackTransactionUnsafe()
            throw DatabaseError.invalidParams(message)
        } catch {
            inTransaction = sqlite3_get_autocommit(handle) == 0
            try? rollbackTransactionUnsafe()
            throw DatabaseError.run("\(error)")
        }
    }

    private func executeAutocommitBatch(_ items: [BatchItem], handle: OpaquePointer, diagnostics: BatchDiagnostics?) throws {
        do {
            let loopStart = DispatchTime.now().uptimeNanoseconds
            for item in items {
                _ = try SQLiteHelpers.run(db: handle, sql: item.sql, values: item.rawValues)
            }
            diagnostics?.set("dbExecuteLoopMs", start: loopStart)
            diagnostics?.set("dbCommitMs", nanos: 0)
        } catch SQLiteError.invalidParams(let message) {
            throw DatabaseError.invalidParams(message)
        } catch {
            inTransaction = sqlite3_get_autocommit(handle) == 0
            throw DatabaseError.run("\(error)")
        }
    }

    private func prepareBatch(
        _ items: [BatchItem],
        handle: OpaquePointer,
        diagnostics: BatchDiagnostics?
    ) throws -> (statements: [String: SQLiteHelpers.PreparedRunStatement], items: [PreparedBatchItem]) {
        var statements: [String: SQLiteHelpers.PreparedRunStatement] = [:]
        var preparedItems: [PreparedBatchItem] = []
        do {
            for item in items {
                let statement = try preparedStatement(
                    for: item,
                    handle: handle,
                    cache: &statements,
                    diagnostics: diagnostics
                )
                preparedItems.append((statement, item.values))
            }
            return (statements, preparedItems)
        } catch SQLiteError.invalidParams(let message) {
            statements.values.forEach { $0.close() }
            throw DatabaseError.invalidParams(message)
        } catch {
            statements.values.forEach { $0.close() }
            throw DatabaseError.run("runBatch validation failed: \(error)")
        }
    }

    private func preparedStatement(
        for item: BatchItem,
        handle: OpaquePointer,
        cache: inout [String: SQLiteHelpers.PreparedRunStatement],
        diagnostics: BatchDiagnostics? = nil
    ) throws -> SQLiteHelpers.PreparedRunStatement {
        if let existing = cache[item.sql] {
            let validateStart = DispatchTime.now().uptimeNanoseconds
            try existing.validate(normalizedValues: item.values)
            diagnostics?.add("dbPrevalidateMs", start: validateStart)
            return existing
        }
        let prepareStart = DispatchTime.now().uptimeNanoseconds
        let statement = try SQLiteHelpers.PreparedRunStatement(
            db: handle,
            sql: item.sql,
            normalizedValues: item.values,
            bindInitialValues: false
        )
        diagnostics?.add("dbPrepareUniqueMs", start: prepareStart)
        cache[item.sql] = statement
        return statement
    }

    private func parseBatch(set: [[String: Any]]) throws -> [BatchItem] {
        var parsed: [BatchItem] = []
        parsed.reserveCapacity(set.count)
        for item in set {
            guard let sql = item["statement"] as? String,
                  sql.containsNonWhitespace else {
                throw DatabaseError.invalidParams("runBatch: each item must have a non-empty 'statement' key")
            }
            let rawValues = item["values"] as? [Any] ?? []
            parsed.append((sql, rawValues, try SQLiteHelpers.normalizeBindValues(rawValues)))
        }
        return parsed
    }

    private func validateBatch(_ items: [BatchItem], handle: OpaquePointer) throws {
        do {
            for item in items {
                try SQLiteHelpers.validateRunStatement(db: handle, sql: item.sql, values: item.rawValues)
            }
        } catch SQLiteError.invalidParams(let message) {
            throw DatabaseError.invalidParams(message)
        } catch {
            throw DatabaseError.run("runBatch validation failed: \(error)")
        }
    }
}

private extension String {
    var containsNonWhitespace: Bool {
        unicodeScalars.contains { !$0.properties.isWhitespace }
    }
}
