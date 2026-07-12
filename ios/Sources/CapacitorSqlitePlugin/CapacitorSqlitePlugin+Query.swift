import Capacitor
import Foundation

extension CapacitorSqlitePlugin {
    @objc func query(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "query")
            return
        }
        guard let statement = call.getString("statement"),
              !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'statement' is required", method: "query")
            return
        }
        guard SQLStatement.isQueryResultStatement(statement) else {
            failure(
                call,
                code: "INVALID_PARAMS",
                message: "'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING",
                method: "query"
            )
            return
        }
        let values: [Any]
        do {
            values = try NativeBridgeValues.decode(call.getArray("values") ?? [], label: "values")
        } catch let error as NativeBridgeValueError {
            failure(call, code: "INVALID_PARAMS", message: error.message, method: "query")
            return
        } catch {
            failure(call, code: "INVALID_PARAMS", message: "Invalid values", method: "query")
            return
        }
        executeQuery(call, database: database, statement: statement, values: values)
    }

    private func executeQuery(
        _ call: CAPPluginCall,
        database: String,
        statement: String,
        values: [Any]
    ) {
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                if call.getBool("__capacitorSqliteCompactRows") == true {
                    let compact = try self.impl.queryCompact(
                        database: database,
                        statement: statement,
                        values: values
                    )
                    self.success(
                        call,
                        data: ["compactRows": ["columns": compact.columns, "values": compact.values]]
                    )
                    return
                }
                let rows = try self.impl.query(database: database, statement: statement, values: values)
                self.success(call, data: ["rows": rows])
            } catch CapacitorSqliteError.failed(let code, let message) {
                self.failure(call, code: code, message: message, method: "query")
            } catch {
                self.failure(
                    call,
                    code: "QUERY_FAILED",
                    message: "query: \(error.localizedDescription)",
                    method: "query"
                )
            }
        }
    }
}
