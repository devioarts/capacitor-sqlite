import Foundation

// swiftlint:disable cyclomatic_complexity
enum SQLStatement {
    private static let typeCache: NSCache<NSString, NSString> = {
        let cache = NSCache<NSString, NSString>()
        cache.countLimit = 256
        return cache
    }()
    private static let conflictCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 256
        return cache
    }()
    private static let returningCache: NSCache<NSString, NSNumber> = {
        let cache = NSCache<NSString, NSNumber>()
        cache.countLimit = 256
        return cache
    }()

    static func type(_ sql: String) -> String {
        if let cached = typeCache.object(forKey: sql as NSString) { return cached as String }
        let result = computeType(sql)
        typeCache.setObject(result as NSString, forKey: sql as NSString)
        return result
    }

    private static func computeType(_ sql: String) -> String {
        let first = readKeyword(sql, from: skipIgnorable(sql, from: sql.startIndex))
        guard let first else { return "" }
        if first.keyword != "WITH" { return first.keyword }
        return withMainStatementType(sql, from: first.end) ?? first.keyword
    }

    static func isInsertLike(_ sql: String) -> Bool {
        let stmtType = type(sql)
        return stmtType == "INSERT" || stmtType == "REPLACE"
    }

    static func isQueryResultStatement(_ sql: String) -> Bool {
        let stmtType = type(sql)
        if stmtType == "SELECT" || stmtType == "PRAGMA" || stmtType == "EXPLAIN" {
            return true
        }
        if stmtType == "INSERT" || stmtType == "UPDATE" || stmtType == "DELETE" || stmtType == "REPLACE" {
            return cachedKeyword(sql, target: "RETURNING", cache: returningCache)
        }
        return false
    }

    // `INSERT ... ON CONFLICT (...) DO UPDATE ...` (SQLite upsert, 3.24+) can resolve as an
    // UPDATE of an existing row instead of an INSERT. SQLite only updates
    // sqlite3_last_insert_rowid() on an actual row-table INSERT, so when the DO UPDATE arm
    // runs, it still reflects whatever the connection's last *real* insert was — a stale,
    // unrelated value. SQLiteHelpers.run() uses this to fall back to lastInsertId 0 for any
    // statement that could take that arm.
    static func hasConflictClause(_ sql: String) -> Bool {
        cachedKeyword(sql, target: "CONFLICT", cache: conflictCache)
    }

    private static func cachedKeyword(
        _ sql: String,
        target: String,
        cache: NSCache<NSString, NSNumber>
    ) -> Bool {
        if let cached = cache.object(forKey: sql as NSString) { return cached.boolValue }
        let result = hasKeyword(sql, target: target)
        cache.setObject(NSNumber(value: result), forKey: sql as NSString)
        return result
    }

    // `WITH cte1 AS (...), cte2 AS (...) <main statement>` — walks past each CTE
    // definition (name, optional column list, `AS [[NOT] MATERIALIZED] (...)`) to find the
    // keyword of the statement the CTEs actually feed (SELECT/INSERT/UPDATE/DELETE).
    // Returns nil if the WITH clause doesn't parse as expected, in which case callers
    // fall back to treating it as a plain 'WITH' statement type.
    private static func withMainStatementType(_ sql: String, from start: String.Index) -> String? {
        var idx = skipIgnorable(sql, from: start)
        if let recursive = readKeyword(sql, from: idx), recursive.keyword == "RECURSIVE" {
            idx = skipIgnorable(sql, from: recursive.end)
        }

        while idx < sql.endIndex {
            idx = skipIdentifier(sql, from: idx)
            guard idx < sql.endIndex else { return nil }

            idx = skipIgnorable(sql, from: idx)
            if sql[idx] == "(" {
                idx = skipParenthesized(sql, from: idx)
                guard idx < sql.endIndex else { return nil }
                idx = skipIgnorable(sql, from: idx)
            }

            guard let asKeyword = readKeyword(sql, from: idx), asKeyword.keyword == "AS" else { return nil }
            idx = skipIgnorable(sql, from: asKeyword.end)

            if let materialized = readKeyword(sql, from: idx) {
                if materialized.keyword == "NOT" {
                    let nextStart = skipIgnorable(sql, from: materialized.end)
                    if let next = readKeyword(sql, from: nextStart), next.keyword == "MATERIALIZED" {
                        idx = skipIgnorable(sql, from: next.end)
                    }
                } else if materialized.keyword == "MATERIALIZED" {
                    idx = skipIgnorable(sql, from: materialized.end)
                }
            }

            guard idx < sql.endIndex, sql[idx] == "(" else { return nil }
            idx = skipIgnorable(sql, from: skipParenthesized(sql, from: idx))
            if idx < sql.endIndex, sql[idx] == "," {
                idx = skipIgnorable(sql, from: sql.index(after: idx))
                continue
            }
            return readKeyword(sql, from: idx)?.keyword
        }
        return nil
    }

    private static func skipIgnorable(_ sql: String, from start: String.Index) -> String.Index {
        var idx = start
        while idx < sql.endIndex {
            let character = sql[idx]
            if character == ";" || isWhitespace(character) {
                idx = sql.index(after: idx)
                continue
            }
            if character == "-", nextChar(sql, after: idx) == "-" {
                idx = sql.index(after: skipLineComment(sql, from: idx))
                continue
            }
            if character == "/", nextChar(sql, after: idx) == "*" {
                idx = sql.index(after: skipBlockComment(sql, from: idx))
                continue
            }
            return idx
        }
        return idx
    }

    private static func readKeyword(_ sql: String, from start: String.Index) -> (keyword: String, end: String.Index)? {
        guard start < sql.endIndex, isIdentifierStart(sql[start]) else { return nil }
        var end = sql.index(after: start)
        while end < sql.endIndex, isIdentifierPart(sql[end]) {
            end = sql.index(after: end)
        }
        return (String(sql[start..<end]).uppercased(), end)
    }

    private static func hasKeyword(_ sql: String, target: String) -> Bool {
        var idx = sql.startIndex
        while idx < sql.endIndex {
            let character = sql[idx]
            if character == "'" || character == "\"" || character == "`" {
                idx = skipQuoted(sql, from: idx, quote: character)
            } else if character == "[" {
                idx = skipBracketIdentifier(sql, from: idx)
            } else if character == "-", nextChar(sql, after: idx) == "-" {
                idx = skipLineComment(sql, from: idx)
            } else if character == "/", nextChar(sql, after: idx) == "*" {
                idx = skipBlockComment(sql, from: idx)
            } else if isIdentifierStart(character),
                      idx == sql.startIndex || !isIdentifierPart(sql[sql.index(before: idx)]) {
                if let keyword = readKeyword(sql, from: idx) {
                    if keyword.keyword == target { return true }
                    idx = sql.index(before: keyword.end)
                }
            }
            idx = sql.index(after: idx)
        }
        return false
    }

    private static func skipIdentifier(_ sql: String, from start: String.Index) -> String.Index {
        var idx = skipIgnorable(sql, from: start)
        guard idx < sql.endIndex else { return idx }
        if sql[idx] == "'" || sql[idx] == "\"" || sql[idx] == "`" {
            return sql.index(after: skipQuoted(sql, from: idx, quote: sql[idx]))
        }
        if sql[idx] == "[" {
            return sql.index(after: skipBracketIdentifier(sql, from: idx))
        }
        while idx < sql.endIndex, isIdentifierPart(sql[idx]) || sql[idx] == "$" {
            idx = sql.index(after: idx)
        }
        return idx
    }

    private static func skipParenthesized(_ sql: String, from start: String.Index) -> String.Index {
        var idx = start
        var depth = 0
        while idx < sql.endIndex {
            let character = sql[idx]
            if character == "'" || character == "\"" || character == "`" {
                idx = skipQuoted(sql, from: idx, quote: character)
            } else if character == "[" {
                idx = skipBracketIdentifier(sql, from: idx)
            } else if character == "-", nextChar(sql, after: idx) == "-" {
                idx = skipLineComment(sql, from: idx)
            } else if character == "/", nextChar(sql, after: idx) == "*" {
                idx = skipBlockComment(sql, from: idx)
            } else if character == "(" {
                depth += 1
            } else if character == ")" {
                depth -= 1
                if depth == 0 { return sql.index(after: idx) }
            }
            idx = sql.index(after: idx)
        }
        return sql.endIndex
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

    private static func isWhitespace(_ character: Character) -> Bool {
        character.unicodeScalars.allSatisfy { CharacterSet.whitespacesAndNewlines.contains($0) }
    }

    private static func isIdentifierStart(_ character: Character) -> Bool {
        character == "_" || character.isLetter
    }

    private static func isIdentifierPart(_ character: Character) -> Bool {
        isIdentifierStart(character) || character.isNumber
    }
}
// swiftlint:enable cyclomatic_complexity
