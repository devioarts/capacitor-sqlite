import Foundation
import Capacitor

// swiftlint:disable type_body_length
@objc(CapacitorSqlitePlugin)
public class CapacitorSqlitePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CapacitorSqlitePlugin"
    public let jsName = "CapacitorSqlite"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPlatform", returnType: CAPPluginReturnPromise),
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
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rollbackTransaction", returnType: CAPPluginReturnPromise)
    ]

    private let impl = CapacitorSqlite()

    // MARK: - Unified response helpers

    private func success(_ call: CAPPluginCall, data: [String: Any] = [:]) {
        resolve(call, payload: ["success": true, "data": data])
    }

    private func failure(_ call: CAPPluginCall, code: String, message: String, method: String) {
        resolve(call, payload: [
            "success": false,
            "error": [
                "code": code,
                "message": message,
                "platform": "ios",
                "method": method,
                "details": [:]
            ] as [String: Any]
        ])
    }

    private func resolve(_ call: CAPPluginCall, payload: [String: Any]) {
        // Capacitor's public docs/source do not guarantee that CAPPluginCall.resolve()
        // is thread-safe, so keep bridge resolution on the main queue.
        if Thread.isMainThread {
            call.resolve(payload)
        } else {
            DispatchQueue.main.async {
                call.resolve(payload)
            }
        }
    }

    private func errorCode(for message: String, fallback: String) -> String {
        if message.contains("not open") { return "DB_NOT_OPEN" }
        if message.contains("Invalid database name") { return "INVALID_NAME" }
        if message.contains("already open") { return "DB_ALREADY_OPEN" }
        if message.contains("transaction is already active") { return "TRANSACTION_FAILED" }
        if message.contains("no transaction is active") { return "TRANSACTION_FAILED" }
        return fallback
    }

    // MARK: - getPlatform

    @objc func getPlatform(_ call: CAPPluginCall) {
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

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.open(database: database, readonly: readonly, migrations: migrations)
                self.success(call)
            } catch CapacitorSqliteError.failed(let msg) {
                let code = self.errorCode(for: msg, fallback: msg.contains("Migration") ? "MIGRATION_FAILED" : "OPEN_FAILED")
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.close(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "CLOSE_FAILED"), message: msg, method: "close")
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
        success(call, data: ["open": impl.isOpen(database: database)])
    }

    // MARK: - getVersion

    @objc func getVersion(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "getVersion")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let version = try self.impl.getVersion(database: database)
                self.success(call, data: ["version": version])
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "VERSION_FAILED"), message: msg, method: "getVersion")
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let version = try self.impl.getSchemaVersion(database: database)
                self.success(call, data: ["version": version])
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(
                    call,
                    code: self.errorCode(for: msg, fallback: "SCHEMA_VERSION_FAILED"),
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.vacuum(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "VACUUM_FAILED"), message: msg, method: "vacuum")
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let changes = try self.impl.execute(database: database, statements: statements, transaction: transaction)
                self.success(call, data: ["changes": changes])
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "EXECUTE_FAILED"), message: msg, method: "execute")
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
        let values = call.getArray("values") ?? []
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let result = try self.impl.run(database: database, statement: statement, values: values)
                self.success(call, data: ["changes": result.changes, "lastInsertId": result.lastInsertId])
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "EXECUTE_FAILED"), message: msg, method: "run")
            } catch {
                self.failure(call, code: "EXECUTE_FAILED", message: "run: \(error.localizedDescription)", method: "run")
            }
        }
    }

    // MARK: - runBatch

    @objc func runBatch(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "runBatch")
            return
        }
        guard let set = call.getArray("set") as? [[String: Any]], !set.isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'set' must be a non-empty array of {statement, values?}", method: "runBatch")
            return
        }
        guard set.allSatisfy({
            guard let statement = $0["statement"] as? String else { return false }
            return !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) else {
            failure(call, code: "INVALID_PARAMS", message: "'set' entries must include a non-empty statement", method: "runBatch")
            return
        }
        let transaction = call.getBool("transaction") ?? true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let result = try self.impl.runBatch(database: database, set: set, transaction: transaction)
                self.success(call, data: ["changes": result.changes, "lastInsertId": result.lastInsertId])
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "EXECUTE_FAILED"), message: msg, method: "runBatch")
            } catch {
                self.failure(call, code: "EXECUTE_FAILED", message: "runBatch: \(error.localizedDescription)", method: "runBatch")
            }
        }
    }

    // MARK: - query

    @objc func query(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "query")
            return
        }
        guard let statement = call.getString("statement"), !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'statement' is required", method: "query")
            return
        }
        let values = call.getArray("values") ?? []
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                let rows = try self.impl.query(database: database, statement: statement, values: values)
                self.success(call, data: ["rows": rows])
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "QUERY_FAILED"), message: msg, method: "query")
            } catch {
                self.failure(call, code: "QUERY_FAILED", message: "query: \(error.localizedDescription)", method: "query")
            }
        }
    }

    // MARK: - beginTransaction

    @objc func beginTransaction(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "beginTransaction")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.beginTransaction(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "TRANSACTION_FAILED"), message: msg, method: "beginTransaction")
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.commitTransaction(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "TRANSACTION_FAILED"), message: msg, method: "commitTransaction")
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            do {
                try self.impl.rollbackTransaction(database: database)
                self.success(call)
            } catch CapacitorSqliteError.failed(let msg) {
                self.failure(call, code: self.errorCode(for: msg, fallback: "TRANSACTION_FAILED"), message: msg, method: "rollbackTransaction")
            } catch {
                self.failure(call, code: "TRANSACTION_FAILED", message: "rollbackTransaction: \(error.localizedDescription)", method: "rollbackTransaction")
            }
        }
    }
}
// swiftlint:enable type_body_length
