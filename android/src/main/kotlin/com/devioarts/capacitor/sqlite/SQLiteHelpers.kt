package com.devioarts.capacitor.sqlite

import android.database.Cursor
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement

internal object SQLiteHelpers {

    // Sentinel prefix for BLOB columns returned from queries.
    // Must stay in sync with BLOB_PREFIX in SQLiteHelpers.swift and index.ts.
    const val BLOB_PREFIX = "blob64:"
    const val TEXT_PREFIX = "text64:"
    private const val MAX_SAFE_INTEGER = 9007199254740991.0

    // MARK: - Lifecycle

    fun open(path: String, readonly: Boolean = false): SQLiteDatabase {
        val flags = if (readonly) SQLiteDatabase.OPEN_READONLY
                    else SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY
        return SQLiteDatabase.openDatabase(path, null, flags)
    }

    // MARK: - DDL / no-result execution

    fun exec(db: SQLiteDatabase, sql: String): Long {
        requireSingleStatement(sql)
        val stmtType = statementType(sql)
        if (isInsertLike(stmtType) || isUpdateDelete(stmtType)) {
            return run(db, sql, emptyList()).changes
        }
        db.execSQL(sql)
        return 0L
    }

    // MARK: - Parameterized DML (single statement)

    fun run(db: SQLiteDatabase, sql: String, values: List<Any?>): RunResult {
        requireSingleStatement(sql)
        val stmt = db.compileStatement(sql)
        try {
            bindValues(stmt, values)
            // total_changes() is a per-connection counter. With WAL connection pooling a
            // read-only SELECT outside a transaction may run on a pooled read connection —
            // wrong counter and per-call pool overhead. Pinning the session to the write
            // connection keeps the counters correct and costs the same single commit as
            // autocommit.
            val pinned = !db.inTransaction()
            if (pinned) db.beginTransactionNonExclusive()
            try {
                val before = totalChanges(db)
                val stmtType = statementType(sql)
                val result = if (isInsertLike(stmtType)) {
                    val lastId = stmt.executeInsert()
                    RunResult(changes = totalChanges(db) - before, lastInsertId = if (lastId >= 0L) lastId else 0L)
                } else {
                    stmt.executeUpdateDelete()
                    RunResult(changes = totalChanges(db) - before, lastInsertId = 0L)
                }
                if (pinned) db.setTransactionSuccessful()
                return result
            } finally {
                if (pinned) db.endTransaction()
            }
        } finally {
            stmt.close()
        }
    }

    // MARK: - SELECT
    // NOTE: Android rawQuery() only accepts String[] parameters, which causes all bound
    // values to be stored as TEXT in SQLite. To preserve type semantics (TYPEOF(?) = "integer"
    // for numbers/booleans, not "text"), non-string non-null primitives are inlined as SQL
    // literals before rawQuery is called. Only String and null values are passed as rawQuery args.

    fun query(db: SQLiteDatabase, sql: String, values: List<Any?>): List<Map<String, Any?>> {
        requireSingleStatement(sql)
        requireQueryResultStatement(sql)
        val (finalSql, finalValues) = injectLiterals(sql, values)
        val strArgs: Array<String?>? = if (finalValues.isEmpty()) null
            else finalValues.map { v ->
                when (v) {
                    null     -> null
                    is String -> v
                    else     -> throw CapacitorSqliteException(
                        "INVALID_PARAMS",
                        "Unsupported query value type: ${v?.javaClass?.name}"
                    )
                }
            }.toTypedArray()
        return db.rawQuery(finalSql, strArgs).use { extractRows(it) }
    }

    // Replace anonymous '?' placeholders with inline SQL literals for all
    // non-string, non-null types. BLOBs -> X'hex', Booleans -> 0/1, Numbers ->
    // numeric literal. String and null values remain as '?' and are passed
    // through rawQuery's String[] args.
    //
    // This is a small SQL lexer, not a full parser. It only needs to know where
    // placeholders are legal, so it skips string literals, quoted identifiers,
    // and SQL comments before counting/replacing '?' markers.
    private fun injectLiterals(sql: String, values: List<Any?>): Pair<String, List<Any?>> {
        val out = StringBuilder(sql.length + 32)
        val remaining = mutableListOf<Any?>()
        var paramIdx = 0
        var i = 0
        while (i < sql.length) {
            val ch = sql[i]
            when (ch) {
                '\'', '"', '`' -> i = copyQuoted(sql, out, i, ch)
                '[' -> i = copyBracketIdentifier(sql, out, i)
                '-' -> if (i + 1 < sql.length && sql[i + 1] == '-') {
                    i = copyLineComment(sql, out, i)
                } else {
                    out.append(ch)
                    i++
                }
                '/' -> if (i + 1 < sql.length && sql[i + 1] == '*') {
                    i = copyBlockComment(sql, out, i)
                } else {
                    out.append(ch)
                    i++
                }
                '?' -> {
                    if (i + 1 < sql.length && sql[i + 1].isDigit()) {
                        throw CapacitorSqliteException(
                            "INVALID_PARAMS",
                            "Only anonymous '?' placeholders are supported; numbered placeholders like '?1' are not supported"
                        )
                    }
                    if (paramIdx >= values.size) {
                        throw CapacitorSqliteException(
                            "INVALID_PARAMS",
                            "Not enough bind values: SQL has more '?' placeholders than values"
                        )
                    }
                    appendValue(out, remaining, values[paramIdx], paramIdx + 1)
                    paramIdx++
                    i++
                }
                ':', '@', '$' -> {
                    if (i + 1 < sql.length && isIdentifierStart(sql[i + 1])) {
                        throw CapacitorSqliteException(
                            "INVALID_PARAMS",
                            "Only anonymous '?' placeholders are supported; named placeholders are not supported"
                        )
                    }
                    out.append(ch)
                    i++
                }
                else -> { out.append(ch); i++ }
            }
        }
        if (paramIdx != values.size) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Too many bind values: SQL has $paramIdx anonymous '?' placeholders but ${values.size} values were provided"
            )
        }
        return out.toString() to remaining
    }

    private fun appendValue(out: StringBuilder, remaining: MutableList<Any?>, value: Any?, idx: Int) {
        when (value) {
            is List<*> -> appendBlobLiteral(out, byteArrayFromList(value, idx))
            is ByteArray -> appendBlobLiteral(out, value)
            is Boolean -> out.append(if (value) "1" else "0")
            is Long -> {
                requireSafeInteger(!isUnsafeInteger(value), idx)
                out.append(value.toString())
            }
            is Int, is Short, is Byte -> out.append(value.toString())
            is Double -> {
                requireFinite(value.isFinite(), idx)
                requireSafeInteger(!isUnsafeInteger(value), idx)
                out.append(value.toString())
            }
            is Float -> {
                requireFinite(value.isFinite(), idx)
                requireSafeInteger(!isUnsafeInteger(value.toDouble()), idx)
                out.append(value.toString())
            }
            null -> out.append("NULL")
            is String -> {
                out.append('?')
                remaining.add(value)
            }
            else -> throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Unsupported query value type at index $idx: ${value::class.java.name}"
            )
        }
    }

    private fun requireSafeInteger(condition: Boolean, idx: Int) {
        if (!condition) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Integer bind value at index $idx must be within Number.MAX_SAFE_INTEGER"
            )
        }
    }

    private fun requireFinite(condition: Boolean, idx: Int) {
        if (!condition) {
            throw CapacitorSqliteException("INVALID_PARAMS", "Numeric bind value at index $idx must be finite")
        }
    }

    private fun appendBlobLiteral(out: StringBuilder, bytes: ByteArray) {
        out.append("X'")
        bytes.forEach { b -> out.append("%02x".format(b.toInt() and 0xFF)) }
        out.append('\'')
    }

    private fun copyQuoted(sql: String, out: StringBuilder, start: Int, quote: Char): Int {
        var i = start
        out.append(sql[i])
        i++
        while (i < sql.length) {
            val ch = sql[i]
            out.append(ch)
            i++
            if (ch == quote) {
                if (i < sql.length && sql[i] == quote) {
                    out.append(sql[i])
                    i++
                } else {
                    break
                }
            }
        }
        return i
    }

    private fun copyBracketIdentifier(sql: String, out: StringBuilder, start: Int): Int {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            out.append(ch)
            i++
            if (ch == ']') break
        }
        return i
    }

    private fun copyLineComment(sql: String, out: StringBuilder, start: Int): Int {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            out.append(ch)
            i++
            if (ch == '\n' || ch == '\r') break
        }
        return i
    }

    private fun copyBlockComment(sql: String, out: StringBuilder, start: Int): Int {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            out.append(ch)
            i++
            if (ch == '*' && i < sql.length && sql[i] == '/') {
                out.append(sql[i])
                i++
                break
            }
        }
        return i
    }

    private fun isIdentifierStart(ch: Char): Boolean =
        ch == '_' || ch.isLetter()

    // MARK: - Transactions
    // All transaction helpers use NON-EXCLUSIVE mode which is compatible with WAL
    // and allows concurrent readers while a write transaction is in progress.

    fun beginTransaction(db: SQLiteDatabase) {
        db.beginTransactionNonExclusive()
    }

    fun commitTransaction(db: SQLiteDatabase) {
        db.setTransactionSuccessful()
        db.endTransaction()
    }

    fun rollbackTransaction(db: SQLiteDatabase) {
        db.endTransaction()
    }

    // MARK: - Version (maps to PRAGMA user_version)

    fun getUserVersion(db: SQLiteDatabase): Int = db.version

    fun getSQLiteVersion(db: SQLiteDatabase): String =
        DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null)

    // longForQuery = compileStatement + simpleQueryForLong: no Cursor/CursorWindow
    // allocation, and the compiled statement is served from the connection cache.
    fun totalChanges(db: SQLiteDatabase): Long =
        DatabaseUtils.longForQuery(db, "SELECT total_changes()", null)

    fun setUserVersion(db: SQLiteDatabase, version: Int) {
        db.version = version
    }

    // MARK: - Helpers

    fun vacuum(db: SQLiteDatabase) {
        db.execSQL("VACUUM")
    }

    fun requireSingleStatement(sql: String) {
        require(!hasMultipleStatements(sql)) { "SQL string must contain exactly one statement" }
    }

    fun hasMultipleStatements(sql: String): Boolean {
        var i = 0
        // Tracks BEGIN/CASE ... END nesting (trigger bodies, CASE expressions) so a
        // semicolon inside one of these blocks isn't mistaken for a statement
        // separator. Only a semicolon seen while this is back at 0 is a real split.
        var blockDepth = 0
        // Tracks '(' / ')' nesting. SQLite does not reserve BEGIN as a keyword, so
        // `CREATE TABLE t(begin TEXT)` is valid SQL — without this, the bare `begin`
        // column name below would be misread as a trigger-body opener and swallow the
        // semicolon after it. A genuine trigger BEGIN always appears outside any
        // parentheses (after `ON ...`/`WHEN ...`/`FOR EACH ROW`), so gating on
        // `parenDepth == 0` filters out identifier occurrences without affecting real
        // trigger bodies.
        var parenDepth = 0
        // `BEGIN` as the very first token is a transaction statement (`BEGIN;`,
        // `BEGIN TRANSACTION;`), not a trigger-body opener — it must not swallow
        // the semicolon that follows it ("BEGIN; DROP TABLE t" is two statements).
        val firstTokenStart = skipIgnorable(sql, 0)
        while (i < sql.length) {
            val ch = sql[i]
            when {
                ch == '\'' || ch == '"' || ch == '`' -> i = skipQuoted(sql, i, ch)
                ch == '[' -> i = skipBracketIdentifier(sql, i)
                ch == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> i = skipLineComment(sql, i)
                ch == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> i = skipBlockComment(sql, i)
                ch == '(' -> parenDepth++
                ch == ')' -> if (parenDepth > 0) parenDepth--
                isIdentifierStart(ch) && (i == 0 || !isIdentifierPart(sql[i - 1])) -> {
                    val keyword = readKeyword(sql, i)
                    if (keyword != null) {
                        // A '.' immediately before rules out a qualified reference like
                        // `NEW.begin` (used in a trigger's WHEN clause, for example) — real
                        // BEGIN/CASE keywords are never preceded by a dot.
                        val isQualifiedRef = i > 0 && sql[i - 1] == '.'
                        when {
                            !isQualifiedRef && keyword.keyword == "BEGIN" && i != firstTokenStart && parenDepth == 0 ->
                                blockDepth++
                            // CASE only nests inside an already-open trigger BEGIN block — a
                            // bare `case` identifier at the top level (SQLite rejects it as
                            // unquoted, but the guard should not depend on that) is otherwise inert.
                            !isQualifiedRef && keyword.keyword == "CASE" && blockDepth > 0 -> blockDepth++
                            keyword.keyword == "END" && blockDepth > 0 -> blockDepth--
                        }
                        i = keyword.end - 1
                    }
                }
                ch == ';' && blockDepth == 0 -> return hasTailContent(sql, i + 1)
            }
            i++
        }
        return false
    }

    // MARK: - Private

    private fun hasTailContent(sql: String, start: Int): Boolean {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            if (ch.isWhitespace() || ch == ';') {
                i++
                continue
            }
            if (ch == '-' && i + 1 < sql.length && sql[i + 1] == '-') {
                i = skipLineComment(sql, i) + 1
                continue
            }
            if (ch == '/' && i + 1 < sql.length && sql[i + 1] == '*') {
                i = skipBlockComment(sql, i) + 1
                continue
            }
            return true
        }
        return false
    }

    private fun skipQuoted(sql: String, start: Int, quote: Char): Int {
        var i = start + 1
        while (i < sql.length) {
            if (sql[i] == quote) {
                if (i + 1 < sql.length && sql[i + 1] == quote) {
                    i += 2
                    continue
                }
                return i
            }
            i++
        }
        return sql.length - 1
    }

    private fun skipBracketIdentifier(sql: String, start: Int): Int {
        var i = start + 1
        while (i < sql.length) {
            if (sql[i] == ']') return i
            i++
        }
        return sql.length - 1
    }

    private fun skipLineComment(sql: String, start: Int): Int {
        var i = start + 2
        while (i < sql.length) {
            if (sql[i] == '\n' || sql[i] == '\r') return i
            i++
        }
        return sql.length - 1
    }

    private fun skipBlockComment(sql: String, start: Int): Int {
        var i = start + 2
        while (i < sql.length - 1) {
            if (sql[i] == '*' && sql[i + 1] == '/') return i + 1
            i++
        }
        return sql.length - 1
    }

    fun statementType(sql: String): String {
        val first = readKeyword(sql, skipIgnorable(sql, 0)) ?: return ""
        if (first.keyword != "WITH") return first.keyword
        return withMainStatementType(sql, first.end) ?: first.keyword
    }

    fun isQueryResultStatement(sql: String): Boolean {
        return when (statementType(sql)) {
            "SELECT", "PRAGMA", "EXPLAIN" -> true
            "INSERT", "UPDATE", "DELETE", "REPLACE" -> hasKeyword(sql, "RETURNING")
            else -> false
        }
    }

    fun requireQueryResultStatement(sql: String) {
        if (!isQueryResultStatement(sql)) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING"
            )
        }
    }

    private fun isInsertLike(stmtType: String): Boolean =
        stmtType == "INSERT" || stmtType == "REPLACE"

    private fun isUpdateDelete(stmtType: String): Boolean =
        stmtType == "UPDATE" || stmtType == "DELETE"

    private data class Keyword(val keyword: String, val end: Int)

    // `WITH cte1 AS (...), cte2 AS (...) <main statement>` — walks past each CTE
    // definition (name, optional column list, `AS [[NOT] MATERIALIZED] (...)`) to find the
    // keyword of the statement the CTEs actually feed (SELECT/INSERT/UPDATE/DELETE).
    // Returns null if the WITH clause doesn't parse as expected, in which case callers
    // fall back to treating it as a plain 'WITH' statement type.
    private fun withMainStatementType(sql: String, start: Int): String? {
        var i = skipIgnorable(sql, start)
        val maybeRecursive = readKeyword(sql, i)
        if (maybeRecursive?.keyword == "RECURSIVE") {
            i = skipIgnorable(sql, maybeRecursive.end)
        }

        while (i < sql.length) {
            i = skipIdentifier(sql, i)
            if (i >= sql.length) return null

            i = skipIgnorable(sql, i)
            if (sql[i] == '(') {
                i = skipParenthesized(sql, i)
                if (i >= sql.length) return null
                i = skipIgnorable(sql, i)
            }

            val asKeyword = readKeyword(sql, i)
            if (asKeyword?.keyword != "AS") return null
            i = skipIgnorable(sql, asKeyword.end)

            val materialized = readKeyword(sql, i)
            if (materialized?.keyword == "NOT") {
                val next = readKeyword(sql, skipIgnorable(sql, materialized.end))
                if (next?.keyword == "MATERIALIZED") {
                    i = skipIgnorable(sql, next.end)
                }
            } else if (materialized?.keyword == "MATERIALIZED") {
                i = skipIgnorable(sql, materialized.end)
            }

            if (i >= sql.length || sql[i] != '(') return null
            i = skipIgnorable(sql, skipParenthesized(sql, i))
            if (i < sql.length && sql[i] == ',') {
                i = skipIgnorable(sql, i + 1)
                continue
            }
            return readKeyword(sql, i)?.keyword
        }
        return null
    }

    private fun skipIgnorable(sql: String, start: Int): Int {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            if (ch.isWhitespace() || ch == ';') {
                i++
                continue
            }
            if (ch == '-' && i + 1 < sql.length && sql[i + 1] == '-') {
                i = skipLineComment(sql, i) + 1
                continue
            }
            if (ch == '/' && i + 1 < sql.length && sql[i + 1] == '*') {
                i = skipBlockComment(sql, i) + 1
                continue
            }
            return i
        }
        return i
    }

    private fun readKeyword(sql: String, start: Int): Keyword? {
        if (start >= sql.length || !isIdentifierStart(sql[start])) return null
        var end = start + 1
        while (end < sql.length && isIdentifierPart(sql[end])) end++
        return Keyword(sql.substring(start, end).uppercase(), end)
    }

    private fun hasKeyword(sql: String, target: String): Boolean {
        var i = 0
        while (i < sql.length) {
            val ch = sql[i]
            when {
                ch == '\'' || ch == '"' || ch == '`' -> i = skipQuoted(sql, i, ch)
                ch == '[' -> i = skipBracketIdentifier(sql, i)
                ch == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> i = skipLineComment(sql, i)
                ch == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> i = skipBlockComment(sql, i)
                isIdentifierStart(ch) && (i == 0 || !isIdentifierPart(sql[i - 1])) -> {
                    val keyword = readKeyword(sql, i)
                    if (keyword?.keyword == target) return true
                    if (keyword != null) i = keyword.end - 1
                }
            }
            i++
        }
        return false
    }

    private fun skipIdentifier(sql: String, start: Int): Int {
        var i = skipIgnorable(sql, start)
        if (i >= sql.length) return i
        if (sql[i] == '\'' || sql[i] == '"' || sql[i] == '`') return skipQuoted(sql, i, sql[i]) + 1
        if (sql[i] == '[') return skipBracketIdentifier(sql, i) + 1
        while (i < sql.length && (isIdentifierPart(sql[i]) || sql[i] == '$')) i++
        return i
    }

    private fun skipParenthesized(sql: String, start: Int): Int {
        var depth = 0
        var i = start
        while (i < sql.length) {
            when (sql[i]) {
                '\'', '"', '`' -> i = skipQuoted(sql, i, sql[i])
                '[' -> i = skipBracketIdentifier(sql, i)
                '-' -> if (i + 1 < sql.length && sql[i + 1] == '-') i = skipLineComment(sql, i)
                '/' -> if (i + 1 < sql.length && sql[i + 1] == '*') i = skipBlockComment(sql, i)
                '(' -> depth++
                ')' -> {
                    depth--
                    if (depth == 0) return i + 1
                }
            }
            i++
        }
        return sql.length
    }

    private fun isIdentifierPart(ch: Char): Boolean =
        isIdentifierStart(ch) || ch.isDigit()

    private fun bindValues(stmt: SQLiteStatement, values: List<Any?>) {
        values.forEachIndexed { i, v ->
            val idx = i + 1
            when (v) {
                null            -> stmt.bindNull(idx)
                is Long         -> {
                    requireSafeInteger(!isUnsafeInteger(v), idx)
                    stmt.bindLong(idx, v)
                }
                is Int          -> stmt.bindLong(idx, v.toLong())
                is Double       -> {
                    requireSafeInteger(!isUnsafeInteger(v), idx)
                    stmt.bindDouble(idx, v)
                }
                is Float        -> {
                    val d = v.toDouble()
                    requireSafeInteger(!isUnsafeInteger(d), idx)
                    stmt.bindDouble(idx, d)
                }
                is Boolean      -> stmt.bindLong(idx, if (v) 1L else 0L)
                is String       -> stmt.bindString(idx, v)
                is ByteArray    -> stmt.bindBlob(idx, v)
                is List<*>      -> stmt.bindBlob(idx, byteArrayFromList(v, idx))
                else            -> throw CapacitorSqliteException(
                    "INVALID_PARAMS",
                    "Unsupported bind value type at index $idx: ${v::class.java.name}"
                )
            }
        }
    }

    private fun byteArrayFromList(value: List<*>, idx: Int): ByteArray {
        return value.mapIndexed { itemIndex, item ->
            val number = item as? Number
                ?: throw CapacitorSqliteException(
                    "INVALID_PARAMS",
                    "BLOB value at index $idx contains a non-number at offset $itemIndex"
                )
            val intValue = number.toInt()
            if (intValue !in 0..255) {
                throw CapacitorSqliteException(
                    "INVALID_PARAMS",
                    "BLOB value at index $idx contains an out-of-range byte at offset $itemIndex"
                )
            }
            intValue.toByte()
        }.toByteArray()
    }

    private fun isUnsafeInteger(value: Double): Boolean =
        value.isFinite() && value % 1.0 == 0.0 && kotlin.math.abs(value) > MAX_SAFE_INTEGER

    private fun isUnsafeInteger(value: Long): Boolean =
        value > MAX_SAFE_INTEGER.toLong() || value < -MAX_SAFE_INTEGER.toLong()

    private fun extractRows(cursor: Cursor): List<Map<String, Any?>> {
        val rows = mutableListOf<Map<String, Any?>>()
        while (cursor.moveToNext()) {
            val row = mutableMapOf<String, Any?>()
            for (i in 0 until cursor.columnCount) {
                val name = cursor.getColumnName(i)
                row[name] = when (cursor.getType(i)) {
                    Cursor.FIELD_TYPE_INTEGER -> normalizeInteger(cursor.getLong(i))
                    Cursor.FIELD_TYPE_FLOAT   -> cursor.getDouble(i)
                    Cursor.FIELD_TYPE_STRING  -> cursor.getString(i)
                    Cursor.FIELD_TYPE_BLOB    -> cursor.getBlob(i)
                    else                      -> null
                }
            }
            rows.add(row)
        }
        return rows
    }

    private fun normalizeInteger(value: Long): Any =
        if (isUnsafeInteger(value)) value.toString() else value
}
