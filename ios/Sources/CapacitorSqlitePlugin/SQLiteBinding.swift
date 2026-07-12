// swiftlint:disable identifier_name
import Foundation
import SQLite3

// SQLITE_TRANSIENT tells SQLite to copy the string/blob before sqlite3_step returns.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let NATIVE_BLOB_BASE64_KEY = "__capacitorSqliteBlobBase64"

enum SQLiteBindValue {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)
}

enum SQLiteBindValues {
    case empty
    case single(SQLiteBindValue)
    case many([SQLiteBindValue])

    var count: Int {
        switch self {
        case .empty: return 0
        case .single: return 1
        case .many(let values): return values.count
        }
    }
}

extension SQLiteHelpers {
    static func normalizeBindValues(_ values: [Any]) throws -> SQLiteBindValues {
        switch values.count {
        case 0:
            return .empty
        case 1:
            return .single(try normalizeBindValue(values[0], idx: 1))
        default:
            var normalized: [SQLiteBindValue] = []
            normalized.reserveCapacity(values.count)
            for (index, value) in values.enumerated() {
                normalized.append(try normalizeBindValue(value, idx: Int32(index + 1)))
            }
            return .many(normalized)
        }
    }

    static func validateBindValues(stmt: OpaquePointer?, values: [Any]) throws {
        let expected = Int(sqlite3_bind_parameter_count(stmt))
        guard values.count == expected else {
            throw SQLiteError.invalidParams(
                "Bind value count mismatch: statement expects \(expected), received \(values.count)"
            )
        }
        for (i, value) in values.enumerated() {
            try validateBindValue(value, idx: Int32(i + 1))
        }
    }

    static func bind(stmt: OpaquePointer?, values: [Any]) throws {
        try validateBindValues(stmt: stmt, values: values)
        for (i, value) in values.enumerated() {
            try bindValue(stmt: stmt, value: value, idx: Int32(i + 1))
        }
    }

    static func bindPrevalidated(stmt: OpaquePointer?, values: [Any]) throws {
        for (i, value) in values.enumerated() {
            try bindPrevalidatedValue(stmt: stmt, value: value, idx: Int32(i + 1))
        }
    }

    static func validateNormalizedBindValues(stmt: OpaquePointer?, values: SQLiteBindValues) throws {
        let expected = Int(sqlite3_bind_parameter_count(stmt))
        guard values.count == expected else {
            throw SQLiteError.invalidParams(
                "Bind value count mismatch: statement expects \(expected), received \(values.count)"
            )
        }
    }

    static func bindNormalized(stmt: OpaquePointer?, values: SQLiteBindValues) throws {
        try validateNormalizedBindValues(stmt: stmt, values: values)
        try bindNormalizedPrevalidated(stmt: stmt, values: values)
    }

    static func bindNormalizedPrevalidated(stmt: OpaquePointer?, values: SQLiteBindValues) throws {
        switch values {
        case .empty:
            return
        case .single(let value):
            try bindNormalizedValue(stmt: stmt, value: value, idx: 1)
        case .many(let values):
            for (i, value) in values.enumerated() {
                try bindNormalizedValue(stmt: stmt, value: value, idx: Int32(i + 1))
            }
        }
    }

    private static func normalizeBindValue(_ value: Any, idx: Int32) throws -> SQLiteBindValue {
        switch value {
        case is NSNull:
            return .null
        case let v as NSArray:
            return .blob(try dataFromArrayBlob(value: v, idx: idx))
        case let v as NSNumber:
            return try normalizeNumber(value: v, idx: idx)
        case let v as String:
            return .text(v)
        case let v as Data:
            return .blob(v)
        case let v as [UInt8]:
            return .blob(Data(v))
        case let v as [String: Any]:
            return .blob(try dataFromTaggedBlob(value: v, idx: idx))
        default:
            throw SQLiteError.execute("Unsupported bind value type at index \(idx)")
        }
    }

    private static func validateBindValue(_ value: Any, idx: Int32) throws {
        switch value {
        case is NSNull, is String, is Data, is [UInt8]:
            return
        case let v as NSArray:
            try validateArrayBlob(value: v, idx: idx)
        case let v as NSNumber:
            try validateNumber(value: v, idx: idx)
        default:
            throw SQLiteError.execute("Unsupported bind value type at index \(idx)")
        }
    }

    private static func bindValue(stmt: OpaquePointer?, value: Any, idx: Int32) throws {
        switch value {
        case is NSNull:
            try checkBind(sqlite3_bind_null(stmt, idx), stmt: stmt, idx: idx)
        case let v as NSArray:
            try bindArrayBlob(stmt: stmt, value: v, idx: idx)
        case let v as NSNumber:
            try bindNumber(stmt: stmt, value: v, idx: idx)
        case let v as String:
            let byteCount = Int32(v.lengthOfBytes(using: .utf8))
            try checkBind(sqlite3_bind_text(stmt, idx, v, byteCount, SQLITE_TRANSIENT), stmt: stmt, idx: idx)
        case let v as Data:
            try bindBlob(stmt: stmt, data: v, idx: idx)
        case let v as [UInt8]:
            try bindBlob(stmt: stmt, data: Data(v), idx: idx)
        default:
            throw SQLiteError.execute("Unsupported bind value type at index \(idx)")
        }
    }

    private static func bindPrevalidatedValue(stmt: OpaquePointer?, value: Any, idx: Int32) throws {
        switch value {
        case is NSNull:
            try checkBind(sqlite3_bind_null(stmt, idx), stmt: stmt, idx: idx)
        case let v as NSArray:
            try bindPrevalidatedArrayBlob(stmt: stmt, value: v, idx: idx)
        case let v as NSNumber:
            try bindPrevalidatedNumber(stmt: stmt, value: v, idx: idx)
        case let v as String:
            let byteCount = Int32(v.lengthOfBytes(using: .utf8))
            try checkBind(sqlite3_bind_text(stmt, idx, v, byteCount, SQLITE_TRANSIENT), stmt: stmt, idx: idx)
        case let v as Data:
            try bindBlob(stmt: stmt, data: v, idx: idx)
        case let v as [UInt8]:
            try bindBlob(stmt: stmt, data: Data(v), idx: idx)
        default:
            throw SQLiteError.execute("Unsupported bind value type at index \(idx)")
        }
    }

    private static func bindNormalizedValue(stmt: OpaquePointer?, value: SQLiteBindValue, idx: Int32) throws {
        switch value {
        case .null:
            try checkBind(sqlite3_bind_null(stmt, idx), stmt: stmt, idx: idx)
        case .integer(let v):
            try checkBind(sqlite3_bind_int64(stmt, idx, v), stmt: stmt, idx: idx)
        case .real(let v):
            try checkBind(sqlite3_bind_double(stmt, idx, v), stmt: stmt, idx: idx)
        case .text(let v):
            let byteCount = Int32(v.lengthOfBytes(using: .utf8))
            try checkBind(sqlite3_bind_text(stmt, idx, v, byteCount, SQLITE_TRANSIENT), stmt: stmt, idx: idx)
        case .blob(let v):
            try bindBlob(stmt: stmt, data: v, idx: idx)
        }
    }

    private static func bindArrayBlob(stmt: OpaquePointer?, value: NSArray, idx: Int32) throws {
        try bindBlob(stmt: stmt, data: dataFromArrayBlob(value: value, idx: idx), idx: idx)
    }

    private static func bindPrevalidatedArrayBlob(stmt: OpaquePointer?, value: NSArray, idx: Int32) throws {
        var bytes = [UInt8]()
        bytes.reserveCapacity(value.count)
        for item in value {
            guard let number = item as? NSNumber else {
                throw SQLiteError.execute("BLOB value at index \(idx) contains a non-number")
            }
            bytes.append(UInt8(number.intValue))
        }
        try bindBlob(stmt: stmt, data: Data(bytes), idx: idx)
    }

    private static func bindNumber(stmt: OpaquePointer?, value: NSNumber, idx: Int32) throws {
        try bindNormalizedValue(stmt: stmt, value: normalizeNumber(value: value, idx: idx), idx: idx)
    }

    private static func bindPrevalidatedNumber(stmt: OpaquePointer?, value: NSNumber, idx: Int32) throws {
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            try checkBind(sqlite3_bind_int(stmt, idx, value.boolValue ? 1 : 0), stmt: stmt, idx: idx)
            return
        }

        let type = value.objCType.pointee
        if type == 100 || type == 102 { // "d" / "f"
            let doubleValue = value.doubleValue
            if let integer = Int64(exactly: doubleValue) {
                try checkBind(sqlite3_bind_int64(stmt, idx, integer), stmt: stmt, idx: idx)
            } else {
                try checkBind(sqlite3_bind_double(stmt, idx, doubleValue), stmt: stmt, idx: idx)
            }
        } else {
            try checkBind(sqlite3_bind_int64(stmt, idx, value.int64Value), stmt: stmt, idx: idx)
        }
    }

    private static func normalizeNumber(value: NSNumber, idx: Int32) throws -> SQLiteBindValue {
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            return .integer(value.boolValue ? 1 : 0)
        }

        let type = value.objCType.pointee
        if type == 100 || type == 102 { // "d" / "f"
            let doubleValue = value.doubleValue
            try validateFloating(doubleValue, idx: idx)
            if let integer = Int64(exactly: doubleValue) {
                return .integer(integer)
            }
            return .real(doubleValue)
        }

        let integerValue = value.int64Value
        try validateInteger(integerValue, idx: idx)
        return .integer(integerValue)
    }

    private static func bindFloatingNumber(stmt: OpaquePointer?, value: Double, idx: Int32) throws {
        if let integer = Int64(exactly: value) {
            try checkBind(sqlite3_bind_int64(stmt, idx, integer), stmt: stmt, idx: idx)
        } else {
            try checkBind(sqlite3_bind_double(stmt, idx, value), stmt: stmt, idx: idx)
        }
    }

    private static func bindInteger(stmt: OpaquePointer?, value: Int64, idx: Int32) throws {
        try validateInteger(value, idx: idx)
        try checkBind(sqlite3_bind_int64(stmt, idx, value), stmt: stmt, idx: idx)
    }

    private static func validateArrayBlob(value: NSArray, idx: Int32) throws {
        for (offset, item) in value.enumerated() {
            _ = try byteValue(item, idx: idx, offset: offset)
        }
    }

    private static func dataFromArrayBlob(value: NSArray, idx: Int32) throws -> Data {
        var bytes = [UInt8]()
        bytes.reserveCapacity(value.count)
        for (offset, item) in value.enumerated() {
            bytes.append(try byteValue(item, idx: idx, offset: offset))
        }
        return Data(bytes)
    }

    private static func dataFromTaggedBlob(value: [String: Any], idx: Int32) throws -> Data {
        guard value.count == 1, let encoded = value[NATIVE_BLOB_BASE64_KEY] as? String else {
            throw SQLiteError.invalidParams("Bind value at index \(idx) must not be an object")
        }
        guard let data = Data(base64Encoded: encoded) else {
            throw SQLiteError.invalidParams("Bind value at index \(idx).\(NATIVE_BLOB_BASE64_KEY) must be valid base64")
        }
        return data
    }

    private static func byteValue(_ item: Any, idx: Int32, offset: Int) throws -> UInt8 {
        guard let number = item as? NSNumber else {
            throw SQLiteError.execute("BLOB value at index \(idx) contains a non-number at offset \(offset)")
        }
        let intValue = number.intValue
        // Reject out-of-range bytes instead of silently clamping them, matching Android
        // (byteArrayFromList in SQLiteHelpers.kt) and Electron (isByteArray in backend.ts).
        guard intValue >= 0, intValue <= 255 else {
            throw SQLiteError.execute("BLOB value at index \(idx) contains an out-of-range byte at offset \(offset)")
        }
        return UInt8(intValue)
    }

    private static func validateNumber(value: NSNumber, idx: Int32) throws {
        if CFGetTypeID(value) == CFBooleanGetTypeID() { return }

        let type = String(cString: value.objCType)
        if type == "d" || type == "f" {
            try validateFloating(value.doubleValue, idx: idx)
        } else {
            try validateInteger(value.int64Value, idx: idx)
        }
    }

    private static func validateFloating(_ value: Double, idx: Int32) throws {
        // Not reachable via the documented public JS API today (index.ts/web.ts already
        // reject non-finite numbers before crossing the bridge) — this is defense in depth
        // for direct native invocation, matching Android's equivalent check in bindValues().
        guard value.isFinite else {
            throw SQLiteError.execute("Numeric bind value at index \(idx) must be finite")
        }

        if value == value.rounded(.towardZero) {
            try validateIntegerMagnitude(value, idx: idx)
        }
    }

    private static func validateInteger(_ value: Int64, idx: Int32) throws {
        if abs(Double(value)) > MAX_SAFE_INTEGER {
            throw SQLiteError.execute("Integer bind value at index \(idx) must be within Number.MAX_SAFE_INTEGER")
        }
    }

    private static func validateIntegerMagnitude(_ value: Double, idx: Int32) throws {
        if abs(value) > MAX_SAFE_INTEGER {
            throw SQLiteError.execute("Integer bind value at index \(idx) must be within Number.MAX_SAFE_INTEGER")
        }
    }

    private static func bindBlob(stmt: OpaquePointer?, data: Data, idx: Int32) throws {
        if data.isEmpty {
            try checkBind(sqlite3_bind_zeroblob(stmt, idx, 0), stmt: stmt, idx: idx)
            return
        }
        let rc = data.withUnsafeBytes { ptr in
            sqlite3_bind_blob(stmt, idx, ptr.baseAddress, Int32(data.count), SQLITE_TRANSIENT)
        }
        try checkBind(rc, stmt: stmt, idx: idx)
    }

    private static func checkBind(_ rc: Int32, stmt: OpaquePointer?, idx: Int32) throws {
        guard rc == SQLITE_OK else {
            let db = sqlite3_db_handle(stmt)
            let message = db.flatMap { String(validatingUTF8: sqlite3_errmsg($0)) } ?? "SQLite bind failed"
            throw SQLiteError.execute("Bind failed at index \(idx): \(message) (code \(rc))")
        }
    }
}
// swiftlint:enable identifier_name
