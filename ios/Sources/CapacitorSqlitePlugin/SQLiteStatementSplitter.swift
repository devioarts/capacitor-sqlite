// swiftlint:disable identifier_name
import Foundation

extension SQLiteHelpers {
    private static let statementSplitCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 256
        return cache
    }()
    private static let bindCountCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 256
        return cache
    }()

    static func validateRunInput(sql: String, valueCount: Int) throws {
        guard !hasMultipleStatements(sql) else {
            throw SQLiteError.invalidParams("SQL string must contain exactly one statement")
        }
        let expected: Int
        if let cached = bindCountCache.object(forKey: sql as NSString) {
            expected = cached.intValue
        } else {
            expected = try anonymousBindCount(sql.unicodeScalars)
            bindCountCache.setObject(NSNumber(value: expected), forKey: sql as NSString)
        }
        guard expected == valueCount else {
            throw SQLiteError.invalidParams(
                "Bind value count mismatch: statement expects \(expected), received \(valueCount)"
            )
        }
    }

    private static func anonymousBindCount(_ sql: String.UnicodeScalarView) throws -> Int {
        var count = 0
        var idx = sql.startIndex
        while idx < sql.endIndex {
            let character = sql[idx]
            if let skipped = skippedLiteralOrComment(sql, from: idx, character: character) {
                idx = skipped
            } else if isIdentifierStart(character), !isWhitespace(character) {
                // A dollar sign inside an identifier is not a named parameter.
                idx = sql.index(before: readKeyword(sql, from: idx).end)
            } else if character == "?" {
                if let next = nextChar(sql, after: idx), (48...57).contains(next.value) {
                    throw SQLiteError.invalidParams("Only anonymous '?' placeholders are supported")
                }
                count += 1
            } else if character == ":" || character == "@" || character == "$",
                      let next = nextChar(sql, after: idx), isIdentifierPart(next) {
                throw SQLiteError.invalidParams("Only anonymous '?' placeholders are supported")
            }
            idx = sql.index(after: idx)
        }
        return count
    }

    static func hasMultipleStatements(_ sql: String) -> Bool {
        if let cached = statementSplitCache.object(forKey: sql as NSString) { return cached.boolValue }
        let result = computeHasMultipleStatements(sql.unicodeScalars)
        statementSplitCache.setObject(NSNumber(value: result), forKey: sql as NSString)
        return result
    }

    // Combining marks must not merge a quote or semicolon with the next SQLite token.
    private static func computeHasMultipleStatements(_ sql: String.UnicodeScalarView) -> Bool {
        // A trigger ends at `; END;`. BEGIN/END elsewhere can be ordinary identifiers.
        var idx = sql.startIndex
        var header = 0
        var trigger = false
        var afterSemicolon = false
        var triggerEnd = false
        while idx < sql.endIndex {
            let ch = sql[idx]
            if isWhitespace(ch) {
                idx = sql.index(after: idx)
                continue
            }
            if let skipped = skippedComment(sql, from: idx, character: ch) {
                idx = sql.index(after: skipped)
                continue
            }
            var token = ""
            if let skipped = skippedLiteralOrComment(sql, from: idx, character: ch) {
                idx = skipped
            } else if ch == ";" {
                if !trigger || triggerEnd { return hasTailContent(sql, from: sql.index(after: idx)) }
                afterSemicolon = true
                triggerEnd = false
                idx = sql.index(after: idx)
                continue
            } else if isIdentifierStart(ch), idx == sql.startIndex || isWhitespace(sql[sql.index(before: idx)]) ||
                        !isIdentifierPart(sql[sql.index(before: idx)]) {
                let keyword = readKeyword(sql, from: idx)
                token = keyword.text
                idx = sql.index(before: keyword.end)
            }
            if (header == 1 || header == 2) && token == "TRIGGER" { trigger = true }
            header = nextTriggerHeader(header, token: token)
            triggerEnd = afterSemicolon && token == "END"
            afterSemicolon = false
            idx = sql.index(after: idx)
        }
        return false
    }

    private static func nextTriggerHeader(_ header: Int, token: String) -> Int {
        switch (header, token) {
        case (0, "EXPLAIN"): return 3
        case (3, "QUERY"): return 4
        case (4, "PLAN"): return 5
        case (0, "CREATE"), (3, "CREATE"), (5, "CREATE"): return 1
        case (1, "TEMP"), (1, "TEMPORARY"): return 2
        default: return -1
        }
    }

    private static func hasTailContent(_ sql: String.UnicodeScalarView, from start: String.Index) -> Bool {
        var idx = start
        while idx < sql.endIndex {
            let ch = sql[idx]
            if ch == ";" || isWhitespace(ch) {
                idx = sql.index(after: idx)
                continue
            }
            if let skipped = skippedComment(sql, from: idx, character: ch) {
                idx = sql.index(after: skipped)
                continue
            }
            return true
        }
        return false
    }

    private static func skippedLiteralOrComment(
        _ sql: String.UnicodeScalarView, from idx: String.Index, character: Unicode.Scalar
    ) -> String.Index? {
        if character == "'" || character == "\"" || character == "`" {
            return skipQuoted(sql, from: idx, quote: character)
        }
        if character == "[" {
            return skipBracketIdentifier(sql, from: idx)
        }
        return skippedComment(sql, from: idx, character: character)
    }

    private static func skippedComment(
        _ sql: String.UnicodeScalarView, from idx: String.Index, character: Unicode.Scalar
    ) -> String.Index? {
        if character == "-", nextChar(sql, after: idx) == "-" {
            return skipLineComment(sql, from: idx)
        }
        if character == "/", nextChar(sql, after: idx) == "*" {
            return skipBlockComment(sql, from: idx)
        }
        return nil
    }

    private static func nextChar(_ sql: String.UnicodeScalarView, after idx: String.Index) -> Unicode.Scalar? {
        let next = sql.index(after: idx)
        return next < sql.endIndex ? sql[next] : nil
    }

    private static func skipQuoted(
        _ sql: String.UnicodeScalarView, from start: String.Index, quote: Unicode.Scalar
    ) -> String.Index {
        var idx = sql.index(after: start)
        while idx < sql.endIndex {
            if sql[idx] == quote {
                let next = sql.index(after: idx)
                if next < sql.endIndex && sql[next] == quote {
                    idx = sql.index(after: next)
                    continue
                }
                return idx
            }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func skipBracketIdentifier(
        _ sql: String.UnicodeScalarView, from start: String.Index
    ) -> String.Index {
        var idx = sql.index(after: start)
        while idx < sql.endIndex {
            if sql[idx] == "]" { return idx }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func skipLineComment(_ sql: String.UnicodeScalarView, from start: String.Index) -> String.Index {
        var idx = sql.index(start, offsetBy: 2, limitedBy: sql.endIndex) ?? sql.endIndex
        while idx < sql.endIndex {
            if sql[idx] == "\n" { return idx }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func skipBlockComment(_ sql: String.UnicodeScalarView, from start: String.Index) -> String.Index {
        var idx = sql.index(start, offsetBy: 2, limitedBy: sql.endIndex) ?? sql.endIndex
        while idx < sql.endIndex {
            if sql[idx] == "*", nextChar(sql, after: idx) == "/" {
                return sql.index(after: idx)
            }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func isWhitespace(_ ch: Unicode.Scalar) -> Bool {
        ch == " " || ch == "\u{FEFF}" || (9...13).contains(ch.value)
    }

    private static func isIdentifierStart(_ ch: Unicode.Scalar) -> Bool {
        ch == "_" || (65...90).contains(ch.value) || (97...122).contains(ch.value) || ch.value >= 128
    }

    private static func isIdentifierPart(_ ch: Unicode.Scalar) -> Bool {
        isIdentifierStart(ch) || (48...57).contains(ch.value) || ch == "$"
    }

    private static func readKeyword(
        _ sql: String.UnicodeScalarView, from start: String.Index
    ) -> (text: String, end: String.Index) {
        var idx = sql.index(after: start)
        while idx < sql.endIndex && isIdentifierPart(sql[idx]) {
            idx = sql.index(after: idx)
        }
        return (String(sql[start..<idx]).uppercased(), idx)
    }
}
// swiftlint:enable identifier_name
