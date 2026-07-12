package com.devioarts.capacitor.sqlite

import android.database.sqlite.SQLiteDatabase
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal data class MigrationEntry(val version: Int, val statements: List<String>)

internal data class RunResult(val changes: Long, val lastInsertId: Long)
internal data class RunManyResult(val changes: Long, val results: List<RunResult>?)

private fun elapsedMs(startNanos: Long): Double = (System.nanoTime() - startNanos) / 1_000_000.0
private fun addTiming(timings: MutableMap<String, Double>?, key: String, startNanos: Long) {
    timings?.put(key, (timings[key] ?: 0.0) + elapsedMs(startNanos))
}

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
    private val runStatementCache = object : LinkedHashMap<String, SQLiteHelpers.PreparedRunStatement>(32, 0.75f, true) {
        override fun removeEldestEntry(
            eldest: MutableMap.MutableEntry<String, SQLiteHelpers.PreparedRunStatement>?
        ): Boolean {
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
                            "open: migrations cannot run while a transaction is active on '$name'"
                        )
                    }
                    runMigrations(handle, migrations)
                }
                return
            }

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
                    try { handle.endTransaction() } catch (_: Exception) { }
                }
                try { handle.close() } catch (_: Exception) { }
                db = null
                throw e
            }
        }
    }

    @Throws(Exception::class)
    fun close(): Unit = lock.withLock {
        val handle = db ?: return@withLock
        if (handle.inTransaction()) {
            try { SQLiteHelpers.rollbackTransaction(handle) } catch (_: Exception) { }
        }
        clearRunStatementCache()
        handle.close()
        db = null
    }

    // MARK: - Execute (DDL / no-result DML, no params)

    @Throws(Exception::class)
    fun execute(statements: List<String>, transaction: Boolean = true): Long = lock.withLock {
        val handle = requireOpen("execute")
        requireWritable("execute")
        clearRunStatementCache()
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
            if (transaction && handle.inTransaction()) SQLiteHelpers.rollbackTransaction(handle)
            if (!transaction && statements.any(SQLiteHelpers::hasRollbackConflictClause)) {
                recoverAutomaticRollback(handle)
            }
            throw e
        }
        totalChanges
    }

    // MARK: - Run (single parameterized DML)

    @Throws(Exception::class)
    fun run(statement: String, values: List<Any?> = emptyList()): RunResult = lock.withLock {
        requireWritable("run")
        val handle = requireOpen("run")
        try {
            val type = SQLiteHelpers.statementType(statement)
            if (type == "INSERT" || type == "REPLACE" || type == "UPDATE" || type == "DELETE") {
                val prepared = runStatementCache[statement]
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
            if (SQLiteHelpers.hasRollbackConflictClause(statement)) recoverAutomaticRollback(handle)
            throw e
        }
    }

    // MARK: - RunBatch

    @Throws(Exception::class)
    fun runBatch(
        set: List<Map<String, Any?>>,
        transaction: Boolean = true,
        timings: MutableMap<String, Double>? = null,
    ): RunResult = lock.withLock {
        val totalStart = System.nanoTime()
        val handle = requireOpen("runBatch")
        requireWritable("runBatch")

        // Parse the whole set before the first statement executes. transaction:false
        // keeps the legacy per-item execution below; the default transactional path
        // additionally retains prepared statements so validation does not compile/bind
        // all 10,000 items twice.
        val parseStart = System.nanoTime()
        val validated = set.map { item ->
            val sql = item["statement"] as? String
                ?: throw IllegalArgumentException("runBatch: each item must have a 'statement' key")
            require(sql.trim().isNotEmpty()) { "runBatch: each item must have a non-empty 'statement' key" }
            @Suppress("UNCHECKED_CAST")
            val vals = item["values"] as? List<Any?> ?: emptyList()
            sql to vals
        }
        timings?.put("dbParseMs", elapsedMs(parseStart))

        val preparedBySql = linkedMapOf<String, SQLiteHelpers.PreparedRunStatement>()
        val validateStart = System.nanoTime()
        val preparedItems = if (transaction) {
            try {
                validated.map { (sql, vals) ->
                    val existing = preparedBySql[sql]
                    val statement = if (existing != null) {
                        // Validate every item's value types before the first write.
                        val prevalidateStart = System.nanoTime()
                        existing.bind(vals)
                        addTiming(timings, "dbPrevalidateMs", prevalidateStart)
                        existing
                    } else {
                        val prepareStart = System.nanoTime()
                        SQLiteHelpers.prepareRunStatement(handle, sql, vals).also {
                            preparedBySql[sql] = it
                            addTiming(timings, "dbPrepareUniqueMs", prepareStart)
                        }
                    }
                    statement to vals
                }
            } catch (error: Exception) {
                preparedBySql.values.forEach { it.close() }
                throw error
            }
        } else {
            // Preserve transaction:false semantics and error precedence: validate every
            // item before the first autocommit, then use run()'s connection pinning and
            // exact per-statement metadata behavior during execution.
            validated.forEach { (sql, vals) -> SQLiteHelpers.validateRunStatement(handle, sql, vals) }
            emptyList<Pair<SQLiteHelpers.PreparedRunStatement, List<Any?>>>()
        }
        timings?.put("dbValidatePrepareMs", elapsedMs(validateStart))

        try {
            if (transaction && handle.inTransaction()) {
                throw CapacitorSqliteException("TRANSACTION_FAILED", "runBatch: a transaction is already active on '$name'")
            }
            if (transaction) {
                val beginStart = System.nanoTime()
                SQLiteHelpers.beginTransaction(handle)
                timings?.put("dbBeginMs", elapsedMs(beginStart))
                val before = SQLiteHelpers.totalChanges(handle)
                try {
                    val loopStart = System.nanoTime()
                    preparedItems.forEach { (statement, values) ->
                        statement.bind(values, timings)
                        statement.execute(timings)
                    }
                    timings?.put("dbExecuteLoopMs", elapsedMs(loopStart))
                    val changes = SQLiteHelpers.totalChanges(handle) - before
                    val commitStart = System.nanoTime()
                    SQLiteHelpers.commitTransaction(handle)
                    timings?.put("dbCommitMs", elapsedMs(commitStart))
                    timings?.put("dbTotalMs", elapsedMs(totalStart))
                    RunResult(changes = changes, lastInsertId = 0)
                } catch (error: Exception) {
                    if (handle.inTransaction()) SQLiteHelpers.rollbackTransaction(handle)
                    throw error
                }
            } else {
                var changes = 0L
                try {
                    val loopStart = System.nanoTime()
                    for ((sql, vals) in validated) changes += SQLiteHelpers.run(handle, sql, vals).changes
                    timings?.put("dbExecuteLoopMs", elapsedMs(loopStart))
                    timings?.put("dbCommitMs", 0.0)
                    timings?.put("dbTotalMs", elapsedMs(totalStart))
                    RunResult(changes = changes, lastInsertId = 0)
                } catch (error: Exception) {
                    if (validated.any { SQLiteHelpers.hasRollbackConflictClause(it.first) }) {
                        recoverAutomaticRollback(handle)
                    }
                    throw error
                }
            }
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
    ): RunManyResult = lock.withLock {
        val handle = requireOpen("runMany")
        requireWritable("runMany")
        if (statement.trim().isEmpty()) {
            throw CapacitorSqliteException("INVALID_PARAMS", "runMany: 'statement' is required")
        }
        if (valueSets.isEmpty()) {
            throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "runMany: 'values' must be a non-empty array of value arrays"
            )
        }

        val prepared = SQLiteHelpers.prepareRunStatement(handle, statement, valueSets.first())
        try {
            // Binding is deterministic validation. Exercise every set before the
            // first write so the default atomic path cannot fail late on a bad type.
            valueSets.forEach(prepared::bind)
            if (transaction && handle.inTransaction()) {
                throw CapacitorSqliteException("TRANSACTION_FAILED", "runMany: a transaction is already active on '$name'")
            }
            val perItem = if (returnResults) ArrayList<RunResult>(valueSets.size) else null
            val before = SQLiteHelpers.totalChanges(handle)
            if (transaction) SQLiteHelpers.beginTransaction(handle)
            try {
                for (values in valueSets) {
                    prepared.bind(values)
                    if (returnResults || !transaction) {
                        val result = prepared.executeWithMetadata()
                        perItem?.add(result)
                    } else {
                        prepared.execute()
                    }
                }
                val changes = SQLiteHelpers.totalChanges(handle) - before
                if (transaction) SQLiteHelpers.commitTransaction(handle)
                RunManyResult(changes, perItem)
            } catch (error: Exception) {
                if (transaction && handle.inTransaction()) SQLiteHelpers.rollbackTransaction(handle)
                if (SQLiteHelpers.hasRollbackConflictClause(statement)) recoverAutomaticRollback(handle)
                throw error
            }
        } finally {
            prepared.close()
        }
    }

    // MARK: - Query

    @Throws(Exception::class)
    fun query(statement: String, values: List<Any?> = emptyList()): List<Map<String, Any?>> = lock.withLock {
        val handle = requireOpen("query")
        try {
            SQLiteHelpers.query(handle, statement, values)
        } catch (e: Exception) {
            if (SQLiteHelpers.hasRollbackConflictClause(statement)) recoverAutomaticRollback(handle)
            throw e
        }
    }

    fun queryCompact(statement: String, values: List<Any?> = emptyList()): SQLiteHelpers.CompactRows = lock.withLock {
        val handle = requireOpen("query")
        try {
            SQLiteHelpers.queryCompact(handle, statement, values)
        } catch (e: Exception) {
            if (SQLiteHelpers.hasRollbackConflictClause(statement)) recoverAutomaticRollback(handle)
            throw e
        }
    }

    // MARK: - Version / Maintenance

    @Throws(Exception::class)
    fun getVersion(): String = lock.withLock {
        SQLiteHelpers.getSQLiteVersion(requireOpen("getVersion"))
    }

    @Throws(Exception::class)
    fun getSchemaVersion(): Int = lock.withLock {
        SQLiteHelpers.getUserVersion(requireOpen("getSchemaVersion"))
    }

    @Throws(Exception::class)
    fun vacuum(): Unit = lock.withLock {
        requireWritable("vacuum")
        SQLiteHelpers.vacuum(requireOpen("vacuum"))
    }

    // MARK: - Transactions
    // ReentrantLock is reentrant — beginTransaction inside runBatch won't deadlock.

    @Throws(Exception::class)
    fun beginTransaction(): Unit = lock.withLock {
        val handle = requireOpen("beginTransaction")
        requireWritable("beginTransaction")
        if (handle.inTransaction()) {
            throw CapacitorSqliteException(
                "TRANSACTION_FAILED",
                "beginTransaction: a transaction is already active on '$name'"
            )
        }
        handle.beginTransactionNonExclusive()
    }

    @Throws(Exception::class)
    fun commitTransaction(): Unit = lock.withLock {
        val handle = requireOpen("commitTransaction")
        if (!handle.inTransaction()) {
            throw CapacitorSqliteException(
                "TRANSACTION_FAILED",
                "commitTransaction: no transaction is active on '$name'"
            )
        }
        SQLiteHelpers.commitTransaction(handle)
    }

    @Throws(Exception::class)
    fun rollbackTransaction(): Unit = lock.withLock {
        val handle = requireOpen("rollbackTransaction")
        if (!handle.inTransaction()) {
            throw CapacitorSqliteException(
                "TRANSACTION_FAILED",
                "rollbackTransaction: no transaction is active on '$name'"
            )
        }
        SQLiteHelpers.rollbackTransaction(handle)
    }

    // MARK: - Migrations (called from open(), already holds lock)

    @Throws(Exception::class)
    private fun runMigrations(handle: SQLiteDatabase, migrations: List<MigrationEntry>) {
        clearRunStatementCache()
        val current = SQLiteHelpers.getUserVersion(handle)

        val pending = migrations
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
                handle.setTransactionSuccessful()
            } catch (e: Exception) {
                handle.endTransaction()
                throw CapacitorSqliteException(
                    "MIGRATION_FAILED",
                    "Migration v${migration.version} failed: ${e.message}",
                    e
                )
            }
            handle.endTransaction()
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
    private fun recoverAutomaticRollback(handle: SQLiteDatabase) {
        if (!handle.inTransaction()) return
        try {
            handle.endTransaction()
        } catch (_: Exception) {
            // The SQL statement already performed the native rollback.
        }
    }
}
