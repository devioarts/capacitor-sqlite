package com.devioarts.capacitor.sqlite

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement

internal object SQLiteHelpers {

    // MARK: - Lifecycle

    fun open(path: String, readonly: Boolean = false): SQLiteDatabase {
        val flags = if (readonly) SQLiteDatabase.OPEN_READONLY
                    else SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY
        return SQLiteDatabase.openDatabase(path, null, flags)
    }

    // MARK: - DDL / no-result execution

    fun exec(db: SQLiteDatabase, sql: String) {
        db.execSQL(sql)
    }

    // MARK: - Parameterized DML (single statement)

    fun run(db: SQLiteDatabase, sql: String, values: List<Any?>): RunResult {
        val stmt = db.compileStatement(sql)
        try {
            bindValues(stmt, values)
            val stmtType = sql.trim().uppercase().split("\\s+".toRegex()).firstOrNull() ?: ""
            val changes = stmt.executeUpdateDelete().toLong()
            val lastId = if ((stmtType == "INSERT" || stmtType == "REPLACE") && changes > 0L) lastInsertRowId(db) else 0L
            return RunResult(changes = changes, lastInsertId = lastId)
        } finally {
            stmt.close()
        }
    }

    // MARK: - SELECT
    // NOTE: Android rawQuery() only accepts String[] parameters.
    // BLOB (ByteArray) parameters cannot be passed directly — they are converted to their
    // string representation which is not meaningful. Use run() with a prepared statement
    // for BLOB parameters in DML; for SELECTs filtering on BLOBs, use hex() comparisons.

    fun query(db: SQLiteDatabase, sql: String, values: List<Any?>): List<Map<String, Any?>> {
        val strArgs: Array<String?>? = if (values.isEmpty()) null
            else values.map { v ->
                when (v) {
                    null        -> null
                    is Boolean  -> if (v) "1" else "0"
                    is String   -> v
                    is Number   -> v.toString()
                    is ByteArray -> throw IllegalArgumentException("BLOB query parameters are not supported on Android")
                    is List<*>  -> throw IllegalArgumentException("BLOB query parameters are not supported on Android")
                    else        -> throw IllegalArgumentException("Unsupported query value type: ${v::class.java.name}")
                }
            }.toTypedArray()
        return db.rawQuery(sql, strArgs).use { extractRows(it) }
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

    fun totalChanges(db: SQLiteDatabase): Long =
        db.rawQuery("SELECT total_changes()", null).use { c ->
            if (c.moveToFirst()) c.getLong(0) else 0L
        }

    fun vacuum(db: SQLiteDatabase) {
        db.execSQL("VACUUM")
    }

    // MARK: - Private

    private fun lastInsertRowId(db: SQLiteDatabase): Long =
        db.rawQuery("SELECT last_insert_rowid()", null).use { c ->
            if (c.moveToFirst()) c.getLong(0) else 0L
        }

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
