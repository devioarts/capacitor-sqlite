// swiftlint:disable identifier_name
import Foundation

extension SQLiteHelpers {
    private static let statementSplitCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 256
        return cache
    }()

    static func hasMultipleStatements(_ sql: String) -> Bool {
        if let cached = statementSplitCache.object(forKey: sql as NSString) { return cached.boolValue }
        let result = computeHasMultipleStatements(sql)
        statementSplitCache.setObject(NSNumber(value: result), forKey: sql as NSString)
        return result
    }

    private static func computeHasMultipleStatements(_ sql: String) -> Bool {
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
            } else if isIdentifierStart(ch), idx == sql.startIndex || !isIdentifierPart(sql[sql.index(before: idx)]) {
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

    private static func hasTailContent(_ sql: String, from start: String.Index) -> Bool {
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
        _ sql: String, from idx: String.Index, character: Character
    ) -> String.Index? {
        if character == "'" || character == "\"" || character == "`" {
            return skipQuoted(sql, from: idx, quote: character)
        }
        if character == "[" {
            return skipBracketIdentifier(sql, from: idx)
        }
        return skippedComment(sql, from: idx, character: character)
    }

    private static func skippedComment(_ sql: String, from idx: String.Index, character: Character) -> String.Index? {
        if character == "-", nextChar(sql, after: idx) == "-" {
            return skipLineComment(sql, from: idx)
        }
        if character == "/", nextChar(sql, after: idx) == "*" {
            return skipBlockComment(sql, from: idx)
        }
        return nil
    }

    private static func nextChar(_ sql: String, after idx: String.Index) -> Character? {
        let next = sql.index(after: idx)
        return next < sql.endIndex ? sql[next] : nil
    }

    private static func skipQuoted(_ sql: String, from start: String.Index, quote: Character) -> String.Index {
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

    private static func skipBracketIdentifier(_ sql: String, from start: String.Index) -> String.Index {
        var idx = sql.index(after: start)
        while idx < sql.endIndex {
            if sql[idx] == "]" { return idx }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func skipLineComment(_ sql: String, from start: String.Index) -> String.Index {
        var idx = sql.index(start, offsetBy: 2, limitedBy: sql.endIndex) ?? sql.endIndex
        while idx < sql.endIndex {
            if sql[idx] == "\n" || sql[idx] == "\r" { return idx }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func skipBlockComment(_ sql: String, from start: String.Index) -> String.Index {
        var idx = sql.index(start, offsetBy: 2, limitedBy: sql.endIndex) ?? sql.endIndex
        while idx < sql.endIndex {
            if sql[idx] == "*", nextChar(sql, after: idx) == "/" {
                return sql.index(after: idx)
            }
            idx = sql.index(after: idx)
        }
        return sql.index(before: sql.endIndex)
    }

    private static func isWhitespace(_ ch: Character) -> Bool {
        ch.unicodeScalars.allSatisfy { CharacterSet.whitespacesAndNewlines.contains($0) }
    }

    private static func isIdentifierStart(_ ch: Character) -> Bool {
        return ch == "_" || ch.isLetter
    }

    private static func isIdentifierPart(_ ch: Character) -> Bool {
        return isIdentifierStart(ch) || ch.isNumber
    }

    private static func readKeyword(_ sql: String, from start: String.Index) -> (text: String, end: String.Index) {
        var idx = sql.index(after: start)
        while idx < sql.endIndex && isIdentifierPart(sql[idx]) {
            idx = sql.index(after: idx)
        }
        return (String(sql[start..<idx]).uppercased(), idx)
    }
}
// swiftlint:enable identifier_name
