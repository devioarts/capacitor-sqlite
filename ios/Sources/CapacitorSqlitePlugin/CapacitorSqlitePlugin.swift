import Foundation
import Capacitor

// swiftlint:disable type_body_length
@objc(CapacitorSqlitePlugin)
public class CapacitorSqlitePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorSqlitePlugin"
    public let jsName = "CapacitorSqlite"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPluginPlatform", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVersion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSchemaVersion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vacuum", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "run", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runBatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runMany", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollbackTransaction", returnType: CAPPluginReturnPromise)
    ]

    let impl = CapacitorSqlite()
    let workQueue = DispatchQueue(label: "com.devioarts.capacitor.sqlite.plugin", qos: .userInitiated)

    deinit {
        // Deinitialization may happen on the main thread. Queue cleanup behind any
        // already-submitted plugin work instead of blocking deinit on SQLite close/WAL I/O.
        let implementation = impl
        workQueue.async {
            implementation.closeAll()
        }
    }

    // MARK: - getPluginPlatform

    @objc func getPluginPlatform(_ call: CAPPluginCall) {
        success(call, data: ["platform": "ios"])
    }

    // MARK: - isAvailable

    @objc func isAvailable(_ call: CAPPluginCall) {
        success(call, data: ["available": impl.isAvailable()])
    }

    // MARK: - open

    @objc func open(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "open")
            return
        }
        let readonly   = call.getBool("readonly") ?? false
        let directory  = call.getString("directory")
        let migrations: [[String: Any]]
        if call.options["migrations"] != nil {
            guard let rawMigrations = call.getArray("migrations") else {
                failure(call, code: "MIGRATION_FAILED", message: "'migrations' must be an array", method: "open")
                return
            }
            guard let parsedMigrations = rawMigrations as? [[String: Any]] else {
                failure(call, code: "MIGRATION_FAILED", message: "'migrations' must be an array of objects", method: "open")
                return
            }
            migrations = parsedMigrations
        } else {
            migrations = []
        }

        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.open(database: database, readonly: readonly, migrations: migrations, directory: directory)
                self.success(call)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "open")
            } catch {
                self.failure(call, code: "OPEN_FAILED", message: "open: \(error.localizedDescription)", method: "open")
            }
        }
    }

    // MARK: - close

    @objc func close(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "close")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.close(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "close")
            } catch {
                self.failure(call, code: "CLOSE_FAILED", message: "close: \(error.localizedDescription)", method: "close")
            }
        }
    }

    // MARK: - isOpen

    @objc func isOpen(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "isOpen")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            self.success(call, data: ["open": self.impl.isOpen(database: database)])
        }
    }

    // MARK: - getVersion

    @objc func getVersion(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "getVersion")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                let version = try self.impl.getVersion(database: database)
                self.success(call, data: ["version": version])
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "getVersion")
            } catch {
                self.failure(call, code: "VERSION_FAILED", message: "getVersion: \(error.localizedDescription)", method: "getVersion")
            }
        }
    }

    // MARK: - getSchemaVersion

    @objc func getSchemaVersion(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "getSchemaVersion")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                let version = try self.impl.getSchemaVersion(database: database)
                self.success(call, data: ["version": version])
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(
                    call,
                    code: code,
                    message: msg,
                    method: "getSchemaVersion"
                )
            } catch {
                self.failure(
                    call,
                    code: "SCHEMA_VERSION_FAILED",
                    message: "getSchemaVersion: \(error.localizedDescription)",
                    method: "getSchemaVersion"
                )
            }
        }
    }

    // MARK: - vacuum

    @objc func vacuum(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "vacuum")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.vacuum(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "vacuum")
            } catch {
                self.failure(call, code: "VACUUM_FAILED", message: "vacuum: \(error.localizedDescription)", method: "vacuum")
            }
        }
    }

    // MARK: - execute

    @objc func execute(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "execute")
            return
        }
        guard let statements = call.getArray("statements") as? [String], !statements.isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'statements' must be a non-empty [String]", method: "execute")
            return
        }
        guard statements.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            failure(call, code: "INVALID_PARAMS", message: "'statements' entries must be non-empty strings", method: "execute")
            return
        }
        let transaction = call.getBool("transaction") ?? true
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                let changes = try self.impl.execute(database: database, statements: statements, transaction: transaction)
                self.success(call, data: ["changes": changes])
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "execute")
            } catch {
                self.failure(call, code: "EXECUTE_FAILED", message: "execute: \(error.localizedDescription)", method: "execute")
            }
        }
    }

    // MARK: - run

    @objc func run(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "run")
            return
        }
        guard let statement = call.getString("statement"), !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'statement' is required", method: "run")
            return
        }
        let values: [Any]
        do {
            values = try NativeBridgeValues.decode(call.getArray("values") ?? [], label: "values")
        } catch let error as NativeBridgeValueError {
            failure(call, code: "INVALID_PARAMS", message: error.message, method: "run")
            return
        } catch {
            failure(call, code: "INVALID_PARAMS", message: "Invalid values", method: "run")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                let result = try self.impl.run(database: database, statement: statement, values: values)
                self.success(call, data: ["changes": result.changes, "lastInsertId": result.lastInsertId])
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "run")
            } catch {
                self.failure(call, code: "EXECUTE_FAILED", message: "run: \(error.localizedDescription)", method: "run")
            }
        }
    }

    // MARK: - runBatch

    @objc func runBatch(_ call: CAPPluginCall) {
        let nativeStart = DispatchTime.now().uptimeNanoseconds
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "runBatch")
            return
        }
        let getArrayStart = DispatchTime.now().uptimeNanoseconds
        guard let set = call.getArray("set") as? [[String: Any]], !set.isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'set' must be a non-empty array of {statement, values?}", method: "runBatch")
            return
        }
        let getArrayEnd = DispatchTime.now().uptimeNanoseconds
        let transaction = call.getBool("transaction") ?? true
        let includeDiagnostics = call.getBool("__diagnostics") == true
        let diagnostics = includeDiagnostics ? BatchDiagnostics() : nil
        diagnostics?.set("pluginGetArrayMs", nanos: getArrayEnd - getArrayStart)
        // runBatch() decodes tagged BLOB envelopes while normalizing values inside
        // Database.parseBatch(). Avoid a second 10k-item native pass over the same
        // payload before enqueueing the actual SQLite work.
        diagnostics?.set("bridgeDecodeMs", nanos: 0)
        let scheduledAt = DispatchTime.now().uptimeNanoseconds
        executeSqlite { [weak self] in
            guard let self = self else { return }
            diagnostics?.set("queueWaitMs", start: scheduledAt)
            do {
                let result = try self.impl.runBatch(
                    database: database,
                    set: set,
                    transaction: transaction,
                    diagnostics: diagnostics
                )
                diagnostics?.set("nativeTotalMs", start: nativeStart)
                var data: [String: Any] = ["changes": result.changes, "lastInsertId": result.lastInsertId]
                if let diagnostics {
                    data["timings"] = diagnostics.timings
                }
                self.success(call, data: data)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "runBatch")
            } catch {
                self.failure(call, code: "EXECUTE_FAILED", message: "runBatch: \(error.localizedDescription)", method: "runBatch")
            }
        }
    }

    // MARK: - beginTransaction

    @objc func beginTransaction(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "beginTransaction")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.beginTransaction(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "beginTransaction")
            } catch {
                self.failure(call, code: "TRANSACTION_FAILED", message: "beginTransaction: \(error.localizedDescription)", method: "beginTransaction")
            }
        }
    }

    // MARK: - commitTransaction

    @objc func commitTransaction(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "commitTransaction")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.commitTransaction(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "commitTransaction")
            } catch {
                self.failure(call, code: "TRANSACTION_FAILED", message: "commitTransaction: \(error.localizedDescription)", method: "commitTransaction")
            }
        }
    }

    // MARK: - rollbackTransaction

    @objc func rollbackTransaction(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "rollbackTransaction")
            return
        }
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.rollbackTransaction(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let code, let msg) {
                self.failure(call, code: code, message: msg, method: "rollbackTransaction")
            } catch {
                self.failure(call, code: "TRANSACTION_FAILED", message: "rollbackTransaction: \(error.localizedDescription)", method: "rollbackTransaction")
            }
        }
    }

}
// swiftlint:enable type_body_length
