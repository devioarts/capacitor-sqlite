package com.devioarts.capacitor.sqlite

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement

internal object SQLiteHelpers {

    // Sentinel prefix for BLOB columns returned from queries.
    // Must stay in sync with BLOB_PREFIX in SQLiteHelpers.swift and index.ts.
    const val BLOB_PREFIX = "blob64:"

    // MARK: - Lifecycle

    fun open(path: String, readonly: Boolean = false): SQLiteDatabase {
        val flags = if (readonly) SQLiteDatabase.OPEN_READONLY
                    else SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY
        return SQLiteDatabase.openDatabase(path, null, flags)
    }

    // MARK: - DDL / no-result execution

    fun exec(db: SQLiteDatabase, sql: String): Long {
        val stmtType = statementType(sql)
        if (isInsertLike(stmtType) || isUpdateDelete(stmtType)) {
            return run(db, sql, emptyList()).changes
        }
        db.execSQL(sql)
        return 0L
    }

    // MARK: - Parameterized DML (single statement)

    fun run(db: SQLiteDatabase, sql: String, values: List<Any?>): RunResult {
        val stmt = db.compileStatement(sql)
        try {
            bindValues(stmt, values)
            val stmtType = statementType(sql)
            if (isInsertLike(stmtType)) {
                val lastId = stmt.executeInsert()
                // NOTE: executeInsert() returns the last inserted rowid but NOT the number of
                // affected rows, so `changes` is reported as 1 for any successful insert. A
                // multi-row INSERT (VALUES (..),(..) or INSERT…SELECT) therefore under-reports
                // `changes` here, unlike iOS/Web/Electron which return the real count.
                // `lastInsertId` is correct in all cases. See README "Cross-platform caveats".
                return RunResult(changes = if (lastId >= 0L) 1L else 0L, lastInsertId = if (lastId >= 0L) lastId else 0L)
            }
            val changes = stmt.executeUpdateDelete().toLong()
            return RunResult(changes = changes, lastInsertId = 0L)
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
        val (finalSql, finalValues) = injectLiterals(sql, values)
        val strArgs: Array<String?>? = if (finalValues.isEmpty()) null
            else finalValues.map { v ->
                when (v) {
                    null     -> null
                    is String -> v
                    else     -> throw IllegalArgumentException("Unsupported query value type: ${v?.javaClass?.name}")
                }
            }.toTypedArray()
        return db.rawQuery(finalSql, strArgs).use { extractRows(it) }
    }

    // Replace '?' placeholders with inline SQL literals for all non-string, non-null types.
    // BLOBs → X'hex', Booleans → 0/1, Numbers → numeric literal.
    // String and null values remain as '?' and are passed through rawQuery's String[] args.
    // Handles single-quoted and double-quoted strings to avoid false '?' matches.
    private fun injectLiterals(sql: String, values: List<Any?>): Pair<String, List<Any?>> {
        if (values.none { it is List<*> || it is Boolean || it is Number }) return sql to values
        val out = StringBuilder(sql.length + 32)
        val remaining = mutableListOf<Any?>()
        var paramIdx = 0
        var i = 0
        while (i < sql.length) {
            val ch = sql[i]
            when (ch) {
                '\'', '"' -> {
                    val quote = ch
                    out.append(ch); i++
                    while (i < sql.length) {
                        val c2 = sql[i]
                        out.append(c2); i++
                        if (c2 == quote) {
                            if (i < sql.length && sql[i] == quote) {
                                out.append(sql[i]); i++  // escaped quote — consume and continue
                            } else break
                        }
                    }
                }
                '?' -> {
                    if (paramIdx < values.size) {
                        val v = values[paramIdx++]
                        when {
                            v is List<*> -> {
                                val bytes = byteArrayFromList(v, paramIdx)
                                out.append("X'")
                                bytes.forEach { b -> out.append("%02x".format(b.toInt() and 0xFF)) }
                                out.append('\'')
                            }
                            v is Boolean -> out.append(if (v) "1" else "0")
                            v is Long || v is Int -> out.append(v.toString())
                            v is Double || v is Float -> out.append(v.toString())
                            else -> { out.append('?'); remaining.add(v) }
                        }
                    } else {
                        out.append('?')
                    }
                    i++
                }
                else -> { out.append(ch); i++ }
            }
        }
        return out.toString() to remaining
    }

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
        db.rawQuery("SELECT sqlite_version()", null).use { c ->
            if (c.moveToFirst()) c.getString(0) else ""
        }

    fun setUserVersion(db: SQLiteDatabase, version: Int) {
        db.version = version
    }

    // MARK: - Helpers

    fun vacuum(db: SQLiteDatabase) {
        db.execSQL("VACUUM")
    }

    // MARK: - Private

    private fun statementType(sql: String): String =
        sql.trimStart().split("\\s+".toRegex()).firstOrNull()?.uppercase() ?: ""

    private fun isInsertLike(stmtType: String): Boolean =
        stmtType == "INSERT" || stmtType == "REPLACE"

    private fun isUpdateDelete(stmtType: String): Boolean =
        stmtType == "UPDATE" || stmtType == "DELETE"

    private fun bindValues(stmt: SQLiteStatement, values: List<Any?>) {
        values.forEachIndexed { i, v ->
            val idx = i + 1
            when (v) {
                null            -> stmt.bindNull(idx)
                is Long         -> stmt.bindLong(idx, v)
                is Int          -> stmt.bindLong(idx, v.toLong())
                is Double       -> stmt.bindDouble(idx, v)
                is Float        -> stmt.bindDouble(idx, v.toDouble())
                is Boolean      -> stmt.bindLong(idx, if (v) 1L else 0L)
                is String       -> stmt.bindString(idx, v)
                is ByteArray    -> stmt.bindBlob(idx, v)
                is List<*>      -> stmt.bindBlob(idx, byteArrayFromList(v, idx))
                else            -> throw IllegalArgumentException("Unsupported bind value type at index $idx: ${v::class.java.name}")
            }
        }
    }

    private fun byteArrayFromList(value: List<*>, idx: Int): ByteArray {
        return value.mapIndexed { itemIndex, item ->
            val number = item as? Number
                ?: throw IllegalArgumentException("BLOB value at index $idx contains a non-number at offset $itemIndex")
            val intValue = number.toInt()
            require(intValue in 0..255) {
                "BLOB value at index $idx contains an out-of-range byte at offset $itemIndex"
            }
            intValue.toByte()
        }.toByteArray()
    }

    private fun extractRows(cursor: Cursor): List<Map<String, Any?>> {
        val rows = mutableListOf<Map<String, Any?>>()
        while (cursor.moveToNext()) {
            val row = mutableMapOf<String, Any?>()
            for (i in 0 until cursor.columnCount) {
                val name = cursor.getColumnName(i)
                row[name] = when (cursor.getType(i)) {
                    Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(i)
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
}
