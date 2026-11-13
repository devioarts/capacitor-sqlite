package com.devioarts.capacitor.sqlite

import android.database.Cursor
import android.database.DatabaseUtils
import android.database.sqlite.SQLiteConstraintException
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteProgram
import android.database.sqlite.SQLiteStatement
import android.os.Build
import androidx.annotation.RequiresApi
import java.util.UUID

internal object SQLiteHelpers {
    val DML_TYPES = setOf("INSERT", "UPDATE", "DELETE", "REPLACE")
    private val TRANSACTION_TYPES = setOf("BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE")
    private val COMMIT_TYPES = setOf("COMMIT", "END")

    internal data class CompactRows(val columns: List<String>, val values: List<List<Any?>>)

    internal class PreparedRunStatement(
        private val db: SQLiteDatabase,
        private val statement: SQLiteStatement,
        private val insertLike: Boolean,
        private val hasConflictClause: Boolean,
        private val parameterCount: Int,
        private val sql: String,
    ) : AutoCloseable {
        private var values: List<Any?> = emptyList()
        private val returning = statementType(sql) in DML_TYPES && hasKeyword(sql, "RETURNING")

        fun bind(values: List<Any?>) {
            requireBindValueCount(parameterCount, values.size)
            statement.clearBindings()
            bindValues(statement, values)
            this.values = values
        }

        fun bind(
            values: List<Any?>,
            timings: MutableMap<String, Double>?,
        ) {
            requireBindValueCount(parameterCount, values.size)
            val clearStart = System.nanoTime()
            statement.clearBindings()
            addPreparedTiming(timings, "dbClearBindingsMs", clearStart)
            val bindStart = System.nanoTime()
            bindValues(statement, values)
            this.values = values
            addPreparedTiming(timings, "dbBindValuesMs", bindStart)
        }

        // The owning batch handles rollback; its hot loop needs no per-row savepoint.
        fun execute(): Long =
            if (returning) {
                queryCompact(db, sql, values, discardRows = true)
                changeState(db).lastInsertRowId
            } else if (insertLike) {
                statement.executeInsert()
            } else {
                statement.executeUpdateDelete()
                0L
            }

        fun execute(timings: MutableMap<String, Double>?) {
            val stepStart = System.nanoTime()
            execute()
            addPreparedTiming(timings, "dbStepMs", stepStart)
        }

        /** Exact public run() metadata while still reusing the prepared statement. */
        fun executeWithMetadata(): RunResult {
            if (statementType(sql) in TRANSACTION_TYPES) {
                if (statementType(sql) in COMMIT_TYPES && db.inTransaction()) {
                    commitTransaction(db)
                } else {
                    statement.execute()
                }
                return RunResult(0L, 0L)
            }
            val pinned = !db.inTransaction()
            if (pinned) db.beginTransactionNonExclusive()
            try {
                val before = changeState(db)
                val insertId = withStatementRecovery(db, sql) { execute() }
                val changes = totalChanges(db) - before.totalChanges
                val reliable =
                    insertLike && !hasConflictClause && changes > 0L &&
                        insertId >= 0L && insertId != before.lastInsertRowId
                if (pinned) commitTransaction(db)
                return RunResult(changes, if (reliable) insertId else 0L)
            } finally {
                if (pinned && db.inTransaction()) db.endTransaction()
            }
        }

        override fun close() = statement.close()
    }

    private data class ChangeState(val totalChanges: Long, val lastInsertRowId: Long)

    private fun addPreparedTiming(
        timings: MutableMap<String, Double>?,
        key: String,
        startNanos: Long,
    ) {
        timings?.put(key, (timings[key] ?: 0.0) + (System.nanoTime() - startNanos) / 1_000_000.0)
    }

    // Sentinel prefix for BLOB columns returned from queries.
    // Must stay in sync with BLOB_PREFIX in SQLiteHelpers.swift and index.ts.
    const val BLOB_PREFIX = "blob64:"
    const val TEXT_PREFIX = "text64:"
    private const val MAX_SAFE_INTEGER = 9007199254740991.0
    private const val SQL_CACHE_LIMIT = 256
    private val multipleStatementCache = sqlCache<Boolean>()
    private val statementTypeCache = sqlCache<String>()
    private val conflictCache = sqlCache<Boolean>()
    private val bindCountCache = sqlCache<Int>()

    private fun <T> sqlCache(): MutableMap<String, T> =
        object : LinkedHashMap<String, T>(SQL_CACHE_LIMIT, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, T>?): Boolean = size > SQL_CACHE_LIMIT
        }

    private fun <T> cached(
        cache: MutableMap<String, T>,
        sql: String,
        compute: () -> T,
    ): T = synchronized(cache) { cache[sql] ?: compute().also { cache[sql] = it } }

    // MARK: - Lifecycle

    fun open(
        path: String,
        readonly: Boolean = false,
    ): SQLiteDatabase {
        val flags =
            if (readonly) {
                SQLiteDatabase.OPEN_READONLY
            } else {
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY
            }
        return SQLiteDatabase.openDatabase(path, null, flags)
    }

    // MARK: - DDL / no-result execution

    fun exec(
        db: SQLiteDatabase,
        sql: String,
    ): Long {
        requireSingleStatement(sql)
        val stmtType = statementType(sql)
        if (stmtType in COMMIT_TYPES && db.inTransaction()) {
            commitTransaction(db)
            return 0L
        }
        if (isInsertLike(stmtType) || isUpdateDelete(stmtType)) {
            return run(db, sql, emptyList()).changes
        }
        withStatementRecovery(db, sql) { db.execSQL(sql) }
        return 0L
    }

    // MARK: - Parameterized DML (single statement)

    fun run(
        db: SQLiteDatabase,
        sql: String,
        values: List<Any?>,
    ): RunResult {
        return prepareRunStatement(db, sql, values).use { it.executeWithMetadata() }
    }

    /** A savepoint detects native auto-rollback without trusting SQL text or undoing caller changes. */
    private fun <T> withStatementRecovery(
        db: SQLiteDatabase,
        sql: String,
        rollbackOnError: Boolean = false,
        block: () -> T,
    ): T {
        if (!db.inTransaction() || statementType(sql) in TRANSACTION_TYPES) {
            return block()
        }
        val marker = "__capacitor_sqlite_statement"
        db.execSQL("SAVEPOINT $marker")
        try {
            val result = block()
            db.execSQL("RELEASE SAVEPOINT $marker")
            return result
        } catch (error: Exception) {
            try {
                // Old Android treats every leading ROLLBACK as endTransaction; prefix bypasses that interception.
                if (rollbackOnError) db.execSQL(";ROLLBACK TO SAVEPOINT $marker")
                db.execSQL("RELEASE SAVEPOINT $marker")
            } catch (cleanup: Exception) {
                if (cleanup.message?.contains("no such savepoint: $marker") == true) {
                    // Native ROLLBACK also removed our marker; unwind only stale framework state.
                    try {
                        db.endTransaction()
                    } catch (_: Exception) {
                    }
                } else {
                    error.addSuppressed(cleanup)
                }
            }
            throw error
        }
    }

    /** Validate the whole batch without preparing SQL (some PRAGMAs act during preparation). */
    fun validateRunInput(
        sql: String,
        values: List<Any?>,
    ) {
        requireSingleStatement(sql)
        requireAnonymousBindParameterCount(sql, values.size)
        values.forEachIndexed { index, value ->
            val position = index + 1
            when (value) {
                null, is String, is Boolean, is Int, is ByteArray -> Unit
                is Long -> requireSafeInteger(!isUnsafeInteger(value), position)
                is Double -> {
                    requireFinite(value.isFinite(), position)
                    requireSafeInteger(!isUnsafeInteger(value), position)
                }
                is Float -> {
                    requireFinite(value.isFinite(), position)
                    requireSafeInteger(!isUnsafeInteger(value.toDouble()), position)
                }
                is List<*> -> byteArrayFromList(value, position)
                else -> throw CapacitorSqliteException("INVALID_PARAMS", "Unsupported bind value type at index $position")
            }
        }
    }

    /** Prepare at first execution; preflight validation must not compile SQL. */
    fun prepareRunStatement(
        db: SQLiteDatabase,
        sql: String,
        values: List<Any?>,
    ): PreparedRunStatement {
        requireSingleStatement(sql)
        requireAnonymousBindParameterCount(sql, values.size)
        val stmt = db.compileStatement(sql)
        try {
            return PreparedRunStatement(
                db,
                stmt,
                isInsertLike(statementType(sql)),
                hasConflictClause(sql),
                values.size,
                sql,
            ).also { it.bind(values) }
        } catch (error: Exception) {
            stmt.close()
            throw error
        }
    }

    // MARK: - SELECT

    fun query(
        db: SQLiteDatabase,
        sql: String,
        values: List<Any?>,
    ): List<Map<String, Any?>> {
        val compact = queryCompact(db, sql, values)
        return compact.values.map { row ->
            linkedMapOf<String, Any?>().also { out ->
                compact.columns.forEachIndexed { index, name -> out[name] = row[index] }
            }
        }
    }

    fun queryCompact(
        db: SQLiteDatabase,
        sql: String,
        values: List<Any?>,
        discardRows: Boolean = false,
    ): CompactRows {
        validateRunInput(sql, values)
        requireQueryResultStatement(sql)
        val writes = statementType(sql) in DML_TYPES
        // PRAGMAs can change connection settings and must retain their autocommit semantics.
        val raw = Build.VERSION.SDK_INT >= 35 && statementType(sql) != "PRAGMA"
        val owned = (writes || raw) && !db.inTransaction()
        if (owned) {
            if (writes) db.beginTransactionNonExclusive() else db.beginTransactionReadOnly()
        }
        try {
            val read = {
                if (raw) {
                    queryRaw(db, sql, values, discardRows)
                } else {
                    queryCursor(db, sql, values, singleWindow = writes, discardRows = discardRows)
                }
            }
            val result = if (writes) withStatementRecovery(db, sql, rollbackOnError = true, block = read) else read()
            if (owned) commitTransaction(db)
            return result
        } finally {
            if (owned && db.inTransaction()) db.endTransaction()
        }
    }

    private fun queryCursor(
        db: SQLiteDatabase,
        sql: String,
        values: List<Any?>,
        singleWindow: Boolean,
        discardRows: Boolean,
    ): CompactRows =
        db.rawQueryWithFactory({ _, driver, editTable, query ->
            bindValues(query, values)
            SQLiteCursor(driver, editTable, query)
        }, sql, emptyArray(), "").use { cursor ->
            if (singleWindow) {
                val count = cursor.count
                if (count > (cursor as SQLiteCursor).window.numRows) {
                    throw CapacitorSqliteException(
                        "QUERY_FAILED",
                        "RETURNING result exceeds Android CursorWindow capacity; use smaller writes or Android 15+",
                    )
                }
            }
            if (discardRows) {
                cursor.moveToLast()
                return@use CompactRows(emptyList(), emptyList())
            }
            val columns = cursor.columnNames.toList()
            val rows = ArrayList<List<Any?>>()
            while (cursor.moveToNext()) {
                rows.add(
                    (0 until cursor.columnCount).map { index ->
                        when (cursor.getType(index)) {
                            Cursor.FIELD_TYPE_INTEGER -> normalizeInteger(cursor.getLong(index))
                            Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
                            Cursor.FIELD_TYPE_STRING -> cursor.getString(index)
                            Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(index)
                            else -> null
                        }
                    },
                )
            }
            CompactRows(columns, rows)
        }

    @RequiresApi(35)
    private fun queryRaw(
        db: SQLiteDatabase,
        sql: String,
        values: List<Any?>,
        discardRows: Boolean,
    ): CompactRows =
        db.createRawStatement(sql).use { statement ->
            values.forEachIndexed { index, value ->
                val position = index + 1
                when (value) {
                    null -> statement.bindNull(position)
                    is String -> statement.bindText(position, value)
                    is Boolean -> statement.bindLong(position, if (value) 1L else 0L)
                    is ByteArray -> statement.bindBlob(position, value)
                    is List<*> -> statement.bindBlob(position, byteArrayFromList(value, position))
                    is Double -> statement.bindDouble(position, value)
                    is Float -> statement.bindDouble(position, value.toDouble())
                    is Number -> statement.bindLong(position, value.toLong())
                }
            }
            if (discardRows) {
                while (statement.step()) { /* Drain RETURNING without materializing its rows. */ }
                return@use CompactRows(emptyList(), emptyList())
            }
            // Android's raw column getters require a current row, including column names.
            if (!statement.step()) return@use CompactRows(emptyList(), emptyList())
            val columns = (0 until statement.resultColumnCount).map(statement::getColumnName)
            val rows = ArrayList<List<Any?>>()
            do {
                rows.add(
                    columns.indices.map { index ->
                        when (statement.getColumnType(index)) {
                            Cursor.FIELD_TYPE_INTEGER -> normalizeInteger(statement.getColumnLong(index))
                            Cursor.FIELD_TYPE_FLOAT -> statement.getColumnDouble(index)
                            Cursor.FIELD_TYPE_STRING -> statement.getColumnText(index)
                            Cursor.FIELD_TYPE_BLOB -> statement.getColumnBlob(index)
                            else -> null
                        }
                    },
                )
            } while (statement.step())
            CompactRows(columns, rows)
        }

    private fun requireSafeInteger(
        condition: Boolean,
        idx: Int,
    ) {
        if (!condition) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Integer bind value at index $idx must be within Number.MAX_SAFE_INTEGER",
            )
        }
    }

    private fun requireFinite(
        condition: Boolean,
        idx: Int,
    ) {
        if (!condition) {
            throw CapacitorSqliteException("INVALID_PARAMS", "Numeric bind value at index $idx must be finite")
        }
    }

    private fun isIdentifierStart(ch: Char): Boolean = ch == '_' || ch in 'A'..'Z' || ch in 'a'..'z' || ch.code >= 128

    // MARK: - Transactions
    // All transaction helpers use NON-EXCLUSIVE mode which is compatible with WAL
    // and allows concurrent readers while a write transaction is in progress.

    fun beginTransaction(db: SQLiteDatabase) {
        db.beginTransactionNonExclusive()
    }

    fun commitTransaction(db: SQLiteDatabase) {
        db.setTransactionSuccessful()
        try {
            db.endTransaction()
        } catch (error: Exception) {
            // After Android releases the session, plain ROLLBACK may use a WAL reader.
            // A guaranteed write constraint forces the writer and rolls back the failed commit.
            val marker = "__capacitor_rollback_" + UUID.randomUUID().toString().replace("-", "")
            try {
                db.execSQL("CREATE TEMP TABLE $marker(v INTEGER NOT NULL)")
                try {
                    db.execSQL("INSERT OR ROLLBACK INTO $marker VALUES(NULL)")
                    throw IllegalStateException("Rollback constraint did not execute")
                } catch (rollback: SQLiteConstraintException) {
                    if (rollback.message?.contains("NOT NULL constraint failed: $marker.v") != true) throw rollback
                }
                db.execSQL("DROP TABLE IF EXISTS temp.$marker")
            } catch (cleanup: Exception) {
                error.addSuppressed(cleanup)
                // An unverified connection must not accept further writes after failed recovery.
                try {
                    db.close()
                } catch (close: Exception) {
                    error.addSuppressed(close)
                }
            }
            throw error
        }
    }

    fun rollbackTransaction(db: SQLiteDatabase) {
        db.endTransaction()
    }

    // MARK: - Version (maps to PRAGMA user_version)

    fun getUserVersion(db: SQLiteDatabase): Int = db.version

    fun getSQLiteVersion(db: SQLiteDatabase): String = DatabaseUtils.stringForQuery(db, "SELECT sqlite_version()", null)

    // longForQuery = compileStatement + simpleQueryForLong: no Cursor/CursorWindow
    // allocation, and the compiled statement is served from the connection cache.
    fun totalChanges(db: SQLiteDatabase): Long = DatabaseUtils.longForQuery(db, "SELECT total_changes()", null)

    private fun changeState(db: SQLiteDatabase): ChangeState =
        db.rawQuery("SELECT total_changes(), last_insert_rowid()", null).use { cursor ->
            check(cursor.moveToFirst()) { "SQLite change-state query returned no row" }
            ChangeState(cursor.getLong(0), cursor.getLong(1))
        }

    fun setUserVersion(
        db: SQLiteDatabase,
        version: Int,
    ) {
        db.version = version
    }

    // MARK: - Helpers

    fun vacuum(db: SQLiteDatabase) {
        db.execSQL("VACUUM")
    }

    fun requireManagedTransactionStatement(sql: String) {
        if (statementType(sql.trim()) in TRANSACTION_TYPES) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Transaction control SQL is not allowed inside an automatically managed transaction",
            )
        }
    }

    fun requireSingleStatement(sql: String) {
        if (hasMultipleStatements(sql)) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "SQL string must contain exactly one statement",
            )
        }
    }

    fun hasMultipleStatements(sql: String): Boolean = cached(multipleStatementCache, sql) { computeHasMultipleStatements(sql) }

    private fun computeHasMultipleStatements(sql: String): Boolean {
        // A trigger ends at `; END;`. BEGIN/END elsewhere can be ordinary identifiers.
        var i = 0
        var header = 0
        var trigger = false
        var afterSemicolon = false
        var triggerEnd = false
        while (i < sql.length) {
            val ch = sql[i]
            if (isSqlWhitespace(ch)) {
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
            var token = ""
            when {
                ch == '\'' || ch == '"' || ch == '`' -> i = skipQuoted(sql, i, ch)
                ch == '[' -> i = skipBracketIdentifier(sql, i)
                ch == ';' -> {
                    if (!trigger || triggerEnd) return hasTailContent(sql, i + 1)
                    afterSemicolon = true
                    triggerEnd = false
                    i++
                    continue
                }
                isIdentifierStart(ch) && (i == 0 || isSqlWhitespace(sql[i - 1]) || !isIdentifierPart(sql[i - 1])) -> {
                    val keyword = readKeyword(sql, i)
                    if (keyword != null) {
                        token = keyword.keyword
                        i = keyword.end - 1
                    }
                }
            }
            when {
                header == 0 && token == "EXPLAIN" -> header = 3
                header == 3 && token == "QUERY" -> header = 4
                header == 4 && token == "PLAN" -> header = 5
                (header == 0 || header == 3 || header == 5) && token == "CREATE" -> header = 1
                header == 1 && (token == "TEMP" || token == "TEMPORARY") -> header = 2
                else -> {
                    if ((header == 1 || header == 2) && token == "TRIGGER") trigger = true
                    header = -1
                }
            }
            triggerEnd = afterSemicolon && token == "END"
            afterSemicolon = false
            i++
        }
        return false
    }

    // MARK: - Private

    private fun hasTailContent(
        sql: String,
        start: Int,
    ): Boolean {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            if (isSqlWhitespace(ch) || ch == ';') {
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

    private fun skipQuoted(
        sql: String,
        start: Int,
        quote: Char,
    ): Int {
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

    private fun skipBracketIdentifier(
        sql: String,
        start: Int,
    ): Int {
        var i = start + 1
        while (i < sql.length) {
            if (sql[i] == ']') return i
            i++
        }
        return sql.length - 1
    }

    private fun skipLineComment(
        sql: String,
        start: Int,
    ): Int {
        var i = start + 2
        while (i < sql.length) {
            if (sql[i] == '\n') return i
            i++
        }
        return sql.length - 1
    }

    private fun skipBlockComment(
        sql: String,
        start: Int,
    ): Int {
        var i = start + 2
        while (i < sql.length - 1) {
            if (sql[i] == '*' && sql[i + 1] == '/') return i + 1
            i++
        }
        return sql.length - 1
    }

    fun statementType(sql: String): String = cached(statementTypeCache, sql) { computeStatementType(sql) }

    private fun computeStatementType(sql: String): String {
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
                "'statement' must be a SELECT, PRAGMA, EXPLAIN, or DML statement with RETURNING",
            )
        }
    }

    // `INSERT ... ON CONFLICT (...) DO UPDATE ...` (SQLite upsert, 3.24+) can resolve as an
    // UPDATE of an existing row instead of an INSERT. SQLite only updates
    // last_insert_rowid() on an actual row-table INSERT, so when the DO UPDATE arm runs, it
    // still reflects whatever the connection's last *real* insert was — a stale, unrelated
    // value. run() uses this to fall back to lastInsertId 0 for any statement that could
    // take that arm.
    fun hasConflictClause(sql: String): Boolean = cached(conflictCache, sql) { hasKeyword(sql, "CONFLICT", "ON") }

    private fun isInsertLike(stmtType: String): Boolean = stmtType == "INSERT" || stmtType == "REPLACE"

    private fun isUpdateDelete(stmtType: String): Boolean = stmtType == "UPDATE" || stmtType == "DELETE"

    private data class Keyword(val keyword: String, val end: Int)

    // `WITH cte1 AS (...), cte2 AS (...) <main statement>` — walks past each CTE
    // definition (name, optional column list, `AS [[NOT] MATERIALIZED] (...)`) to find the
    // keyword of the statement the CTEs actually feed (SELECT/INSERT/UPDATE/DELETE).
    // Returns null if the WITH clause doesn't parse as expected, in which case callers
    // fall back to treating it as a plain 'WITH' statement type.
    private fun withMainStatementType(
        sql: String,
        start: Int,
    ): String? {
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

    private fun skipIgnorable(
        sql: String,
        start: Int,
    ): Int {
        var i = start
        while (i < sql.length) {
            val ch = sql[i]
            if (isSqlWhitespace(ch) || ch == ';') {
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

    private fun readKeyword(
        sql: String,
        start: Int,
    ): Keyword? {
        if (start >= sql.length || !isIdentifierStart(sql[start])) return null
        var end = start + 1
        while (end < sql.length && isIdentifierPart(sql[end])) end++
        return Keyword(sql.substring(start, end).uppercase(), end)
    }

    private fun hasKeyword(
        sql: String,
        target: String,
        precededBy: String? = null,
    ): Boolean {
        var previous = ""
        var i = 0
        while (i < sql.length) {
            val ch = sql[i]
            when {
                ch == '\'' || ch == '"' || ch == '`' -> {
                    i = skipQuoted(sql, i, ch)
                    previous = ""
                }
                ch == '[' -> {
                    i = skipBracketIdentifier(sql, i)
                    previous = ""
                }
                ch == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> i = skipLineComment(sql, i)
                ch == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> i = skipBlockComment(sql, i)
                !isSqlWhitespace(ch) && isIdentifierStart(ch) &&
                    (i == 0 || isSqlWhitespace(sql[i - 1]) || !isIdentifierPart(sql[i - 1])) -> {
                    val keyword = readKeyword(sql, i)
                    if (keyword?.keyword == target && (precededBy == null || previous == precededBy)) return true
                    previous = keyword?.keyword ?: ""
                    if (keyword != null) i = keyword.end - 1
                }
                !isSqlWhitespace(ch) -> previous = ""
            }
            i++
        }
        return false
    }

    private fun isSqlWhitespace(ch: Char): Boolean = ch == ' ' || ch == '\uFEFF' || ch in '\t'..'\r'

    private fun skipIdentifier(
        sql: String,
        start: Int,
    ): Int {
        var i = skipIgnorable(sql, start)
        if (i >= sql.length) return i
        if (sql[i] == '\'' || sql[i] == '"' || sql[i] == '`') return skipQuoted(sql, i, sql[i]) + 1
        if (sql[i] == '[') return skipBracketIdentifier(sql, i) + 1
        while (i < sql.length && (isIdentifierPart(sql[i]) || sql[i] == '$')) i++
        return i
    }

    private fun skipParenthesized(
        sql: String,
        start: Int,
    ): Int {
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

    private fun isIdentifierPart(ch: Char): Boolean = isIdentifierStart(ch) || ch.isDigit() || ch == '$'

    private fun requireAnonymousBindParameterCount(
        sql: String,
        valueCount: Int,
    ) {
        val count = cached(bindCountCache, sql) { scanAnonymousBindParameterCount(sql) }
        if (count != valueCount) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Bind value count mismatch: statement expects $count, received $valueCount",
            )
        }
    }

    private fun scanAnonymousBindParameterCount(sql: String): Int {
        var count = 0
        var i = 0
        while (i < sql.length) {
            val ch = sql[i]
            when {
                ch == '\'' || ch == '"' || ch == '`' -> i = skipQuoted(sql, i, ch)
                ch == '[' -> i = skipBracketIdentifier(sql, i)
                ch == '-' && i + 1 < sql.length && sql[i + 1] == '-' -> i = skipLineComment(sql, i)
                ch == '/' && i + 1 < sql.length && sql[i + 1] == '*' -> i = skipBlockComment(sql, i)
                ch == '?' -> {
                    if (i + 1 < sql.length && sql[i + 1].isDigit()) {
                        throw CapacitorSqliteException(
                            "INVALID_PARAMS",
                            "Only anonymous '?' placeholders are supported; numbered placeholders are not supported",
                        )
                    }
                    count++
                }
                (ch == ':' || ch == '@' || ch == '$') &&
                    i + 1 < sql.length && isIdentifierPart(sql[i + 1]) &&
                    (ch != '$' || i == 0 || isSqlWhitespace(sql[i - 1]) || !isIdentifierPart(sql[i - 1])) ->
                    throw CapacitorSqliteException(
                        "INVALID_PARAMS",
                        "Only anonymous '?' placeholders are supported; named placeholders are not supported",
                    )
            }
            i++
        }
        return count
    }

    private fun bindValues(
        stmt: SQLiteProgram,
        values: List<Any?>,
    ) {
        values.forEachIndexed { i, v ->
            val idx = i + 1
            when (v) {
                null -> stmt.bindNull(idx)
                is Long -> {
                    requireSafeInteger(!isUnsafeInteger(v), idx)
                    stmt.bindLong(idx, v)
                }
                is Int -> stmt.bindLong(idx, v.toLong())
                is Double -> {
                    requireFinite(v.isFinite(), idx)
                    requireSafeInteger(!isUnsafeInteger(v), idx)
                    stmt.bindDouble(idx, v)
                }
                is Float -> {
                    val d = v.toDouble()
                    requireFinite(d.isFinite(), idx)
                    requireSafeInteger(!isUnsafeInteger(d), idx)
                    stmt.bindDouble(idx, d)
                }
                is Boolean -> stmt.bindLong(idx, if (v) 1L else 0L)
                is String -> stmt.bindString(idx, v)
                is ByteArray -> stmt.bindBlob(idx, v)
                is List<*> -> stmt.bindBlob(idx, byteArrayFromList(v, idx))
                else -> throw CapacitorSqliteException(
                    "INVALID_PARAMS",
                    "Unsupported bind value type at index $idx: ${v::class.java.name}",
                )
            }
        }
    }

    private fun byteArrayFromList(
        value: List<*>,
        idx: Int,
    ): ByteArray {
        return value.mapIndexed { itemIndex, item ->
            val number =
                item as? Number
                    ?: throw CapacitorSqliteException(
                        "INVALID_PARAMS",
                        "BLOB value at index $idx contains a non-number at offset $itemIndex",
                    )
            val intValue = number.toInt()
            if (!number.toDouble().isFinite() || number.toDouble() != intValue.toDouble() || intValue !in 0..255) {
                throw CapacitorSqliteException(
                    "INVALID_PARAMS",
                    "BLOB value at index $idx contains an out-of-range byte at offset $itemIndex",
                )
            }
            intValue.toByte()
        }.toByteArray()
    }

    private fun isUnsafeInteger(value: Double): Boolean =
        value.isFinite() && value % 1.0 == 0.0 && kotlin.math.abs(value) > MAX_SAFE_INTEGER

    private fun isUnsafeInteger(value: Long): Boolean = value > MAX_SAFE_INTEGER.toLong() || value < -MAX_SAFE_INTEGER.toLong()

    private fun normalizeInteger(value: Long): Any = if (isUnsafeInteger(value)) value.toString() else value
}
