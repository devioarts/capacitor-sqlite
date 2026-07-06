import Capacitor
import Foundation

extension CapacitorSqlitePlugin {
    func success(_ call: CAPPluginCall, data: [String: Any] = [:]) {
        resolve(call, payload: ["success": true, "data": data])
    }

    func failure(_ call: CAPPluginCall, code: String, message: String, method: String) {
        let details: [String: Any] = [
            "nativeCode": code,
            "nativeMessage": message,
            "source": "ios-native"
        ]
        resolve(call, payload: [
            "success": false,
            "error": [
                "code": code,
                "message": message,
                "platform": "ios",
                "method": method,
                "details": details
            ] as [String: Any]
        ])
    }

    func executeSqlite(_ block: @escaping () -> Void) {
        workQueue.async(execute: block)
    }

    private func resolve(_ call: CAPPluginCall, payload: [String: Any]) {
        if Thread.isMainThread {
            call.resolve(payload)
        } else {
            DispatchQueue.main.async {
                call.resolve(payload)
            }
        }
    }
}
