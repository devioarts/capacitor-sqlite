// swiftlint:disable identifier_name
import Foundation
import SQLite3

extension SQLiteHelpers {
    struct CompactRows {
        let columns: [String]
        let values: [[Any]]
    }

    static func fetchRows(stmt: OpaquePointer?, db: OpaquePointer) throws -> [[String: Any]] {
        var rows: [[String: Any]] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else {
                let msg = String(validatingUTF8: sqlite3_errmsg(db)) ?? "step failed"
                throw SQLiteError.query(msg)
            }
            rows.append(try readRow(stmt: stmt))
        }
        return rows
    }

    static func fetchCompactRows(stmt: OpaquePointer?, db: OpaquePointer) throws -> CompactRows {
        let count = sqlite3_column_count(stmt)
        let columns = try (0..<count).map { index -> String in
            guard let name = sqlite3_column_name(stmt, index) else {
                throw SQLiteError.query("column_name failed at index \(index)")
            }
            return String(cString: name)
        }
        var rows: [[Any]] = []
        while true {
            let result = sqlite3_step(stmt)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else {
                let message = String(validatingUTF8: sqlite3_errmsg(db)) ?? "step failed"
                throw SQLiteError.query(message)
            }
            rows.append(try (0..<count).map { try readColumn(stmt: stmt, index: $0) })
        }
        return CompactRows(columns: columns, values: rows)
    }

    private static func readRow(stmt: OpaquePointer?) throws -> [String: Any] {
        let count = sqlite3_column_count(stmt)
        var row: [String: Any] = [:]
        for i in 0..<count {
            guard let namePtr = sqlite3_column_name(stmt, i) else {
                throw SQLiteError.query("column_name failed at index \(i)")
            }
            row[String(cString: namePtr)] = try readColumn(stmt: stmt, index: i)
        }
        return row
    }

    private static func readColumn(stmt: OpaquePointer?, index: Int32) throws -> Any {
        switch sqlite3_column_type(stmt, index) {
        case SQLITE_INTEGER:
            return normalizeInteger(sqlite3_column_int64(stmt, index))
        case SQLITE_FLOAT:
            return sqlite3_column_double(stmt, index)
        case SQLITE_TEXT:
            return try readText(stmt: stmt, index: index)
        case SQLITE_BLOB:
            return readBlob(stmt: stmt, index: index)
        default:
            return NSNull()
        }
    }

    private static func readText(stmt: OpaquePointer?, index: Int32) throws -> Any {
        guard let ptr = sqlite3_column_text(stmt, index) else { return NSNull() }
        let byteCount = Int(sqlite3_column_bytes(stmt, index))
        let bytes = UnsafeBufferPointer(start: ptr, count: byteCount)
        guard let text = String(bytes: bytes, encoding: .utf8) else {
            throw SQLiteError.query("invalid UTF-8 text at column \(index)")
        }
        return encodeText(text)
    }

    private static func readBlob(stmt: OpaquePointer?, index: Int32) -> Any {
        let byteCount = Int(sqlite3_column_bytes(stmt, index))
        if byteCount == 0 {
            return BLOB_PREFIX
        }
        guard let ptr = sqlite3_column_blob(stmt, index) else { return NSNull() }
        let data = Data(bytes: ptr, count: byteCount)
        return BLOB_PREFIX + data.base64EncodedString()
    }

    private static func encodeText(_ text: String) -> String {
        if text.hasPrefix(BLOB_PREFIX) || text.hasPrefix(TEXT_PREFIX),
           let bytes = text.data(using: .utf8) {
            return TEXT_PREFIX + bytes.base64EncodedString()
        }
        return text
    }

    private static func normalizeInteger(_ value: Int64) -> Any {
        if abs(Double(value)) > MAX_SAFE_INTEGER {
            return String(value)
        }
        return value
    }
}
// swiftlint:enable identifier_name
