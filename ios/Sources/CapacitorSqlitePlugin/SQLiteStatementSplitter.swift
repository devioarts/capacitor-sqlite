// swiftlint:disable identifier_name
import Foundation

extension SQLiteHelpers {
    static func hasMultipleStatements(_ sql: String) -> Bool {
        var idx = sql.startIndex
        var blockDepth = 0
        let firstTokenStart = firstMeaningfulIndex(sql)

        while idx < sql.endIndex {
            let ch = sql[idx]
            if let skipped = skippedLiteralOrComment(sql, from: idx, character: ch) {
                idx = skipped
            } else if isIdentifierStart(ch), idx == sql.startIndex || !isIdentifierPart(sql[sql.index(before: idx)]) {
                let keyword = readKeyword(sql, from: idx)
                blockDepth = updatedBlockDepth(blockDepth, keyword: keyword.text, at: idx, firstTokenStart: firstTokenStart)
                idx = sql.index(before: keyword.end)
            } else if ch == ";", blockDepth == 0 {
                return hasTailContent(sql, from: sql.index(after: idx))
            }
            idx = sql.index(after: idx)
        }
        return false
    }

    private static func updatedBlockDepth(
        _ depth: Int,
        keyword: String,
        at idx: String.Index,
        firstTokenStart: String.Index
    ) -> Int {
        switch keyword {
        case "BEGIN":
            return idx == firstTokenStart ? depth : depth + 1
        case "CASE":
            return depth + 1
        case "END":
            return max(0, depth - 1)
        default:
            return depth
        }
    }

    private static func firstMeaningfulIndex(_ sql: String) -> String.Index {
        var idx = sql.startIndex
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
            return idx
        }
        return idx
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

    private static func skippedLiteralOrComment(_ sql: String, from idx: String.Index, character: Character) -> String.Index? {
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
