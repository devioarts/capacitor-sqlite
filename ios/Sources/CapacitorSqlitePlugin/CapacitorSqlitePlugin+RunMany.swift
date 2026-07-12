import Capacitor
import Foundation

private struct RunManyBridgeRequest {
    let database: String
    let statement: String
    let valueSets: [[Any]]
    let transaction: Bool
    let returnResults: Bool
}

extension CapacitorSqlitePlugin {
    @objc func runMany(_ call: CAPPluginCall) {
        guard let database = call.getString("database") else {
            failure(call, code: "INVALID_PARAMS", message: "'database' is required", method: "runMany")
            return
        }
        guard let statement = call.getString("statement"),
              !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            failure(call, code: "INVALID_PARAMS", message: "'statement' is required", method: "runMany")
            return
        }
        guard let rawValues = call.getArray("values"), !rawValues.isEmpty else {
            failure(
                call,
                code: "INVALID_PARAMS",
                message: "'values' must be a non-empty array of value arrays",
                method: "runMany"
            )
            return
        }
        let valueSets: [[Any]]
        do {
            valueSets = try NativeBridgeValues.decodeMany(rawValues)
        } catch let error as NativeBridgeValueError {
            failure(call, code: "INVALID_PARAMS", message: error.message, method: "runMany")
            return
        } catch {
            failure(call, code: "INVALID_PARAMS", message: "Invalid values", method: "runMany")
            return
        }
        executeRunMany(call, request: RunManyBridgeRequest(
            database: database,
            statement: statement,
            valueSets: valueSets,
            transaction: call.getBool("transaction") ?? true,
            returnResults: call.getBool("returnResults") ?? false
        ))
    }

    private func executeRunMany(_ call: CAPPluginCall, request: RunManyBridgeRequest) {
        executeSqlite { [weak self] in
            guard let self = self else { return }
            do {
                let result = try self.impl.runMany(
                    database: request.database,
                    statement: request.statement,
                    valueSets: request.valueSets,
                    transaction: request.transaction,
                    returnResults: request.returnResults
                )
                var data: [String: Any] = ["changes": result.changes, "lastInsertId": 0]
                if let results = result.results {
                    data["results"] = results.map {
                        ["changes": $0.changes, "lastInsertId": $0.lastInsertId]
                    }
                }
                self.success(call, data: data)
            } catch CapacitorSqliteError.failed(let code, let message) {
                self.failure(call, code: code, message: message, method: "runMany")
            } catch {
                self.failure(
                    call,
                    code: "EXECUTE_FAILED",
                    message: "runMany: \(error.localizedDescription)",
                    method: "runMany"
                )
            }
        }
    }
}
