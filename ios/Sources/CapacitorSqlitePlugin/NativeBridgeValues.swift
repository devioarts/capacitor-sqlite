import Foundation

struct NativeBridgeValueError: Error {
    let message: String
}

enum NativeBridgeValues {
    private static let blobBase64Key = "__capacitorSqliteBlobBase64"

    static func decode(_ values: [Any], label: String) throws -> [Any] {
        try values.enumerated().map { index, value in
            try decodeValue(value, label: "\(label)[\(index)]")
        }
    }

    static func decodeMany(_ valueSets: [Any]) throws -> [[Any]] {
        try valueSets.enumerated().map { index, value in
            guard let values = value as? [Any] else {
                throw NativeBridgeValueError(message: "'values[\(index)]' must be an array")
            }
            return try decode(values, label: "values[\(index)]")
        }
    }

    private static func decodeValue(_ value: Any, label: String) throws -> Any {
        guard let object = value as? [String: Any] else { return value }
        guard object.count == 1, let encoded = object[blobBase64Key] as? String else {
            throw NativeBridgeValueError(message: "'\(label)' must not be an object")
        }
        guard let data = Data(base64Encoded: encoded) else {
            throw NativeBridgeValueError(message: "'\(label).\(blobBase64Key)' must be valid base64")
        }
        return data
    }
}
