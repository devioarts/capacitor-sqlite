package com.devioarts.capacitor.sqlite

import android.database.sqlite.SQLiteDatabase
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal data class MigrationEntry(val version: Int, val statements: List<String>)

internal data class RunResult(val changes: Long, val lastInsertId: Long)

internal data class RunManyResult(val changes: Long, val results: List<RunResult>?)

private fun elapsedMs(startNanos: Long): Double = (System.nanoTime() - startNanos) / 1_000_000.0

internal class Database(
    val name: String,
    val path: String,
    val readonly: Boolean = false,
) {
    private var db: SQLiteDatabase? = null

    // Serializes all ops on this database including open/close — prevents all races.
    private val lock = ReentrantLock()

    // Public run() often repeats a small set of application statements. Keep a
    // bounded per-connection cache; execute()/migrations clear it before any SQL
    // which may change the schema, and close() finalizes every native handle.
    private val runStatementCache =
        object : LinkedHashMap<String, SQLiteHelpers.PreparedRunStatement>(32, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, SQLiteHelpers.PreparedRunStatement>?): Boolean {
                if (size <= 32) return false
                eldest?.value?.close()
                return true
            }
        }

    val isOpen: Boolean
        get() = lock.withLock { db?.isOpen == true }

    // MARK: - Lifecycle

    @Throws(Exception::class)
    fun open(migrations: List<MigrationEntry> = emptyList()) {
        lock.withLock {
            if (db?.isOpen == true) {
                if (migrations.isNotEmpty()) {
                    val handle = db ?: return
                    if (handle.inTransaction()) {
                        throw CapacitorSqliteException(
                            "MIGRATION_FAILED",
                            "open: migrations cannot run while a transaction is active on '$name'",
                        )
                    }
                    runMigrations(handle, migrations)
                }
                return
            }

            // Failed commit recovery can close the handle; its cached statements cannot be reused.
            clearRunStatementCache()
            val handle = SQLiteHelpers.open(path, readonly)
            db = handle
            try {
                // PRAGMA busy_timeout returns the new value as a result row;
                // Android's execSQL() rejects row-returning statements.
                handle.rawQuery("PRAGMA busy_timeout = 5000", null).use { it.moveToFirst() }
                if (!readonly) {
                    // WAL requires a real file; in-memory databases skip it.
                    if (path != ":memory:") handle.enableWriteAheadLogging()
                    handle.execSQL("PRAGMA foreign_keys = ON;")

                    if (migrations.isNotEmpty()) {
                        runMigrations(handle, migrations)
                    }
                }
            } catch (e: Exception) {
                if (handle.inTransaction()) {
                    try {
                        handle.endTransaction()
                    } catch (_: Exception) {
                    }
                }
                try {
                    handle.close()
                } catch (_: Exception) {
                }
                db = null
                throw e
            }
        }
    }

    @Throws(Exception::class)
    fun close(): Unit =
        lock.withLock {
            val handle = db ?: return@withLock
            if (handle.inTransaction()) {
                try {
                    SQLiteHelpers.rollbackTransaction(handle)
                } catch (_: Exception) {
                }
            }
            clearRunStatementCache()
            handle.close()
            db = null
        }

    // MARK: - Execute (DDL / no-result DML, no params)

    @Throws(Exception::class)
    fun execute(
        statements: List<String>,
        transaction: Boolean = true,
    ): Long =
        lock.withLock {
            val handle = requireOpen("execute")
            requireWritable("execute")
            clearRunStatementCache()
            if (transaction) statements.forEach(SQLiteHelpers::requireManagedTransactionStatement)
            if (transaction && handle.inTransaction()) {
                throw CapacitorSqliteException("TRANSACTION_FAILED", "execute: a transaction is already active on '$name'")
            }
            if (transaction) SQLiteHelpers.beginTransaction(handle)
            var totalChanges = 0L
            try {
                for (sql in statements) {
                    val trimmed = sql.trim()
                    if (trimmed.isNotEmpty()) totalChanges += SQLiteHelpers.exec(handle, trimmed)
                }
                if (transaction) SQLiteHelpers.commitTransaction(handle)
            } catch (e: Exception) {
                if (transaction) rollbackOwnedTransaction(handle)
                throw e
            }
            totalChanges
        }

    // MARK: - Run (single parameterized DML)

    @Throws(Exception::class)
    fun run(
        statement: String,
        values: List<Any?> = emptyList(),
    ): RunResult =
        lock.withLock {
            requireWritable("run")
            val handle = requireOpen("run")
            try {
                val type = SQLiteHelpers.statementType(statement)
                if (type == "INSERT" || type == "REPLACE" || type == "UPDATE" || type == "DELETE") {
                    val prepared =
                        runStatementCache[statement]
                            ?: SQLiteHelpers.prepareRunStatement(handle, statement, values).also {
                                runStatementCache[statement] = it
                            }
                    prepared.bind(values)
                    prepared.executeWithMetadata()
                } else {
                    SQLiteHelpers.run(handle, statement, values)
                }
            } catch (e: Exception) {
                runStatementCache.remove(statement)?.close()
                throw e
            }
        }

    // MARK: - RunBatch

    @Throws(Exception::class)
    fun runBatch(
        set: List<Map<String, Any?>>,
        transaction: Boolean = true,
        timings: MutableMap<String, Double>? = null,
    ): RunResult =
        lock.withLock {
            val totalStart = System.nanoTime()
            val handle = requireOpen("runBatch")
            requireWritable("runBatch")

            val parseStart = System.nanoTime()
            val validated =
                set.map { item ->
                    val sql = item["statement"] as? String
                    if (sql.isNullOrBlank()) {
                        throw CapacitorSqliteException("INVALID_PARAMS", "runBatch: each item must have a non-empty 'statement' key")
                    }
                    val rawValues = item["values"]
                    if (rawValues != null && rawValues !is List<*>) {
                        throw CapacitorSqliteException("INVALID_PARAMS", "runBatch: 'values' must be an array")
                    }
                    val values = rawValues as? List<*> ?: emptyList<Any?>()
                    SQLiteHelpers.validateRunInput(sql, values)
                    if (transaction) SQLiteHelpers.requireManagedTransactionStatement(sql)
                    sql to values
                }
            timings?.put("dbParseMs", elapsedMs(parseStart))
            if (transaction && handle.inTransaction()) {
                throw CapacitorSqliteException("TRANSACTION_FAILED", "runBatch: a transaction is already active on '$name'")
            }
            // Prepare in execution order: later SQL can depend on schema created earlier in this batch.
            val preparedBySql = linkedMapOf<String, SQLiteHelpers.PreparedRunStatement>()
            if (transaction) SQLiteHelpers.beginTransaction(handle)
            var changes = 0L
            try {
                val before = if (transaction) SQLiteHelpers.totalChanges(handle) else 0L
                for ((sql, values) in validated) {
                    val reusable = SQLiteHelpers.statementType(sql) in SQLiteHelpers.DML_TYPES
                    if (!reusable) {
                        // DDL invalidates cached statements; PRAGMAs must be prepared on every execution.
                        preparedBySql.values.forEach { it.close() }
                        preparedBySql.clear()
                        clearRunStatementCache()
                    }
                    val prepared =
                        preparedBySql[sql] ?: SQLiteHelpers.prepareRunStatement(handle, sql, values).also {
                            if (reusable) preparedBySql[sql] = it
                        }
                    try {
                        prepared.bind(values, timings)
                        if (transaction) {
                            prepared.execute(timings)
                        } else {
                            changes += prepared.executeWithMetadata().changes
                        }
                    } finally {
                        if (!reusable) prepared.close()
                    }
                }
                if (transaction) {
                    changes = SQLiteHelpers.totalChanges(handle) - before
                    SQLiteHelpers.commitTransaction(handle)
                }
                timings?.put("dbTotalMs", elapsedMs(totalStart))
                RunResult(changes, 0)
            } catch (error: Exception) {
                if (transaction) rollbackOwnedTransaction(handle)
                throw error
            } finally {
                preparedBySql.values.forEach { it.close() }
            }
        }

    // MARK: - RunMany

    @Throws(Exception::class)
    fun runMany(
        statement: String,
        valueSets: List<List<Any?>>,
        transaction: Boolean = true,
        returnResults: Boolean = false,
    ): RunManyResult =
        lock.withLock {
            val handle = requireOpen("runMany")
            requireWritable("runMany")
            if (statement.trim().isEmpty()) {
                throw CapacitorSqliteException("INVALID_PARAMS", "runMany: 'statement' is required")
            }
            if (valueSets.isEmpty()) {
                throw CapacitorSqliteException(
                    "INVALID_PARAMS",
                    "runMany: 'values' must be a non-empty array of value arrays",
                )
            }

            valueSets.forEach { SQLiteHelpers.validateRunInput(statement, it) }
            if (transaction) SQLiteHelpers.requireManagedTransactionStatement(statement)
            if (transaction && handle.inTransaction()) {
                throw CapacitorSqliteException("TRANSACTION_FAILED", "runMany: a transaction is already active on '$name'")
            }
            val perItem = if (returnResults) ArrayList<RunResult>(valueSets.size) else null
            val reusable = SQLiteHelpers.statementType(statement) in SQLiteHelpers.DML_TYPES
            var prepared: SQLiteHelpers.PreparedRunStatement? = null
            if (transaction) SQLiteHelpers.beginTransaction(handle)
            try {
                // total_changes is connection-local; read only after pinning the writer.
                val before = if (transaction) SQLiteHelpers.totalChanges(handle) else 0L
                var itemChanges = 0L
                for (values in valueSets) {
                    val current = prepared ?: SQLiteHelpers.prepareRunStatement(handle, statement, values).also { prepared = it }
                    current.bind(values)
                    if (returnResults || !transaction) {
                        val result = current.executeWithMetadata()
                        perItem?.add(result)
                        itemChanges += result.changes
                    } else {
                        current.execute()
                    }
                    if (!reusable) {
                        current.close()
                        prepared = null
                        clearRunStatementCache()
                    }
                }
                val changes = if (transaction) SQLiteHelpers.totalChanges(handle) - before else itemChanges
                if (transaction) SQLiteHelpers.commitTransaction(handle)
                RunManyResult(changes, perItem)
            } catch (error: Exception) {
                if (transaction) rollbackOwnedTransaction(handle)
                throw error
            } finally {
                prepared?.close()
            }
        }

    // MARK: - Query

    @Throws(Exception::class)
    fun query(
        statement: String,
        values: List<Any?> = emptyList(),
    ): List<Map<String, Any?>> =
        lock.withLock {
            val handle = requireOpen("query")
            SQLiteHelpers.query(handle, statement, values)
        }

    fun queryCompact(
        statement: String,
        values: List<Any?> = emptyList(),
    ): SQLiteHelpers.CompactRows =
        lock.withLock {
            val handle = requireOpen("query")
            SQLiteHelpers.queryCompact(handle, statement, values)
        }

    // MARK: - Version / Maintenance

    @Throws(Exception::class)
    fun getVersion(): String =
        lock.withLock {
            SQLiteHelpers.getSQLiteVersion(requireOpen("getVersion"))
        }

    @Throws(Exception::class)
    fun getSchemaVersion(): Int =
        lock.withLock {
            SQLiteHelpers.getUserVersion(requireOpen("getSchemaVersion"))
        }

    @Throws(Exception::class)
    fun vacuum(): Unit =
        lock.withLock {
            requireWritable("vacuum")
            SQLiteHelpers.vacuum(requireOpen("vacuum"))
        }

    // MARK: - Transactions
    // ReentrantLock is reentrant — beginTransaction inside runBatch won't deadlock.

    @Throws(Exception::class)
    fun beginTransaction(): Unit =
        lock.withLock {
            val handle = requireOpen("beginTransaction")
            requireWritable("beginTransaction")
            if (handle.inTransaction()) {
                throw CapacitorSqliteException(
                    "TRANSACTION_FAILED",
                    "beginTransaction: a transaction is already active on '$name'",
                )
            }
            handle.beginTransactionNonExclusive()
        }

    @Throws(Exception::class)
    fun commitTransaction(): Unit =
        lock.withLock {
            val handle = requireOpen("commitTransaction")
            if (!handle.inTransaction()) {
                throw CapacitorSqliteException(
                    "TRANSACTION_FAILED",
                    "commitTransaction: no transaction is active on '$name'",
                )
            }
            SQLiteHelpers.commitTransaction(handle)
        }

    @Throws(Exception::class)
    fun rollbackTransaction(): Unit =
        lock.withLock {
            val handle = requireOpen("rollbackTransaction")
            if (!handle.inTransaction()) {
                throw CapacitorSqliteException(
                    "TRANSACTION_FAILED",
                    "rollbackTransaction: no transaction is active on '$name'",
                )
            }
            SQLiteHelpers.rollbackTransaction(handle)
        }

    // MARK: - Migrations (called from open(), already holds lock)

    @Throws(Exception::class)
    private fun runMigrations(
        handle: SQLiteDatabase,
        migrations: List<MigrationEntry>,
    ) {
        // Validate even skipped/future versions before any version can commit.
        for (migration in migrations) {
            try {
                migration.statements.forEach {
                    SQLiteHelpers.requireSingleStatement(it.trim())
                    SQLiteHelpers.requireManagedTransactionStatement(it)
                }
            } catch (error: Exception) {
                throw CapacitorSqliteException("MIGRATION_FAILED", "Migration v${migration.version} failed: ${error.message}", error)
            }
        }
        clearRunStatementCache()
        val current = SQLiteHelpers.getUserVersion(handle)

        val pending =
            migrations
                .filter { it.version > current }
                .sortedBy { it.version }

        for (migration in pending) {
            handle.beginTransactionNonExclusive()
            try {
                for (sql in migration.statements) {
                    val trimmed = sql.trim()
                    SQLiteHelpers.requireSingleStatement(trimmed)
                    handle.execSQL(trimmed)
                }
                SQLiteHelpers.setUserVersion(handle, migration.version)
                SQLiteHelpers.commitTransaction(handle)
            } catch (e: Exception) {
                rollbackOwnedTransaction(handle)
                throw CapacitorSqliteException(
                    "MIGRATION_FAILED",
                    "Migration v${migration.version} failed: ${e.message}",
                    e,
                )
            }
        }
    }

    private fun clearRunStatementCache() {
        runStatementCache.values.forEach { it.close() }
        runStatementCache.clear()
    }

    // MARK: - Private

    @Throws(IllegalStateException::class)
    private fun requireOpen(context: String): SQLiteDatabase {
        val handle = db
        if (handle == null || !handle.isOpen) {
            throw CapacitorSqliteException("DB_NOT_OPEN", "$context: '$name' is not open")
        }
        return handle
    }

    private fun requireWritable(context: String) {
        check(!readonly) { "$context: database '$name' is open in readonly mode" }
    }

    /**
     * SQLite's OR ROLLBACK can end the native transaction underneath Android's
     * SQLiteSession bookkeeping. endTransaction() may report that SQLite already
     * rolled back, but it still unwinds the framework transaction stack; suppress
     * that expected secondary error so a new transaction can start normally.
     */
    private fun rollbackOwnedTransaction(handle: SQLiteDatabase) {
        if (!handle.inTransaction()) return
        try {
            handle.endTransaction()
        } catch (_: Exception) {
            // The SQL statement already performed the native rollback.
        }
    }
}
