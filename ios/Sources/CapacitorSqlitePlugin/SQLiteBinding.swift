// swiftlint:disable identifier_name
import Foundation
import SQLite3

// SQLITE_TRANSIENT tells SQLite to copy the string/blob before sqlite3_step returns.
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

extension SQLiteHelpers {
    static func bind(stmt: OpaquePointer?, values: [Any]) throws {
        for (i, value) in values.enumerated() {
            try bindValue(stmt: stmt, value: value, idx: Int32(i + 1))
        }
    }

    private static func bindValue(stmt: OpaquePointer?, value: Any, idx: Int32) throws {
        switch value {
        case is NSNull:
            sqlite3_bind_null(stmt, idx)
        case let v as NSArray:
            try bindArrayBlob(stmt: stmt, value: v, idx: idx)
        case let v as NSNumber:
            try bindNumber(stmt: stmt, value: v, idx: idx)
        case let v as String:
            let byteCount = Int32(v.lengthOfBytes(using: .utf8))
            sqlite3_bind_text(stmt, idx, v, byteCount, SQLITE_TRANSIENT)
        case let v as Data:
            bindBlob(stmt: stmt, data: v, idx: idx)
        case let v as [UInt8]:
            bindBlob(stmt: stmt, data: Data(v), idx: idx)
        default:
            throw SQLiteError.execute("Unsupported bind value type at index \(idx)")
        }
    }

    private static func bindArrayBlob(stmt: OpaquePointer?, value: NSArray, idx: Int32) throws {
        var bytes = [UInt8]()
        bytes.reserveCapacity(value.count)
        for (offset, item) in value.enumerated() {
            guard let number = item as? NSNumber else {
                throw SQLiteError.execute("BLOB value at index \(idx) contains a non-number at offset \(offset)")
            }
            let intValue = number.intValue
            // Reject out-of-range bytes instead of silently clamping them, matching Android
            // (byteArrayFromList in SQLiteHelpers.kt) and Electron (isByteArray in backend.ts).
            guard intValue >= 0, intValue <= 255 else {
                throw SQLiteError.execute("BLOB value at index \(idx) contains an out-of-range byte at offset \(offset)")
            }
            bytes.append(UInt8(intValue))
        }
        bindBlob(stmt: stmt, data: Data(bytes), idx: idx)
    }

    private static func bindNumber(stmt: OpaquePointer?, value: NSNumber, idx: Int32) throws {
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            sqlite3_bind_int(stmt, idx, value.boolValue ? 1 : 0)
            return
        }

        let type = String(cString: value.objCType)
        if type == "d" || type == "f" {
            try bindFloatingNumber(stmt: stmt, value: value.doubleValue, idx: idx)
        } else {
            try bindInteger(stmt: stmt, value: value.int64Value, idx: idx)
        }
    }

    private static func bindFloatingNumber(stmt: OpaquePointer?, value: Double, idx: Int32) throws {
        if value.isFinite,
           value == value.rounded(.towardZero),
           abs(value) > MAX_SAFE_INTEGER {
            throw SQLiteError.execute("Integer bind value at index \(idx) must be within Number.MAX_SAFE_INTEGER")
        }

        if !value.isNaN && !value.isInfinite,
           let integer = Int64(exactly: value) {
            sqlite3_bind_int64(stmt, idx, integer)
        } else {
            sqlite3_bind_double(stmt, idx, value)
        }
    }

    private static func bindInteger(stmt: OpaquePointer?, value: Int64, idx: Int32) throws {
        if abs(Double(value)) > MAX_SAFE_INTEGER {
            throw SQLiteError.execute("Integer bind value at index \(idx) must be within Number.MAX_SAFE_INTEGER")
        }
        sqlite3_bind_int64(stmt, idx, value)
    }

    private static func bindBlob(stmt: OpaquePointer?, data: Data, idx: Int32) {
        if data.isEmpty {
            sqlite3_bind_zeroblob(stmt, idx, 0)
            return
        }
        data.withUnsafeBytes { ptr in
            _ = sqlite3_bind_blob(stmt, idx, ptr.baseAddress, Int32(data.count), SQLITE_TRANSIENT)
        }
    }
}
// swiftlint:enable identifier_name
