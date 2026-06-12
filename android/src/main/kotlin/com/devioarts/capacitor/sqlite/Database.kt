package com.devioarts.capacitor.sqlite

import android.database.sqlite.SQLiteDatabase
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal data class MigrationEntry(val version: Int, val statements: List<String>)

internal data class RunResult(val changes: Long, val lastInsertId: Long)

internal class Database(
    val name: String,
    val path: String,
    val readonly: Boolean = false,
) {
    private var db: SQLiteDatabase? = null
    // Serializes all ops on this database including open/close — prevents all races.
    private val lock = ReentrantLock()

    val isOpen: Boolean
        get() = lock.withLock { db?.isOpen == true }

    // MARK: - Lifecycle

    @Throws(Exception::class)
    fun open(migrations: List<MigrationEntry> = emptyList()) {
        lock.withLock {
            if (db?.isOpen == true) return

            val handle = SQLiteHelpers.open(path, readonly)
            db = handle
            try {
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
        handle.close()
        db = null
    }

    // MARK: - Execute (DDL / no-result DML, no params)

    @Throws(Exception::class)
    fun execute(statements: List<String>, transaction: Boolean = true): Long = lock.withLock {
        val handle = requireOpen("execute")
        val before = SQLiteHelpers.totalChanges(handle)
        if (transaction && handle.inTransaction()) {
            throw IllegalStateException("execute: a transaction is already active on '$name'")
        }
        if (transaction) SQLiteHelpers.beginTransaction(handle)
        try {
            for (sql in statements) {
                val trimmed = sql.trim()
                if (trimmed.isNotEmpty()) SQLiteHelpers.exec(handle, trimmed)
            }
            if (transaction) SQLiteHelpers.commitTransaction(handle)
        } catch (e: Exception) {
            if (transaction && handle.inTransaction()) SQLiteHelpers.rollbackTransaction(handle)
            throw e
        }
        SQLiteHelpers.totalChanges(handle) - before
    }

    // MARK: - Run (single parameterized DML)

    @Throws(Exception::class)
    fun run(statement: String, values: List<Any?> = emptyList()): RunResult = lock.withLock {
        SQLiteHelpers.run(requireOpen("run"), statement, values)
    }

    // MARK: - RunBatch

    @Throws(Exception::class)
    fun runBatch(set: List<Map<String, Any?>>, transaction: Boolean = true): RunResult = lock.withLock {
        val handle = requireOpen("runBatch")
        val before = SQLiteHelpers.totalChanges(handle)

        if (transaction && handle.inTransaction()) {
            throw IllegalStateException("runBatch: a transaction is already active on '$name'")
        }
        if (transaction) SQLiteHelpers.beginTransaction(handle)
        try {
            for (item in set) {
                val sql = item["statement"] as? String
                    ?: throw IllegalArgumentException("runBatch: each item must have a 'statement' key")
                require(sql.trim().isNotEmpty()) { "runBatch: each item must have a non-empty 'statement' key" }
                @Suppress("UNCHECKED_CAST")
                val vals = item["values"] as? List<Any?> ?: emptyList()
                SQLiteHelpers.run(handle, sql, vals)
            }
            if (transaction) SQLiteHelpers.commitTransaction(handle)
        } catch (e: Exception) {
            if (transaction && handle.inTransaction()) SQLiteHelpers.rollbackTransaction(handle)
            throw e
        }

        RunResult(changes = SQLiteHelpers.totalChanges(handle) - before, lastInsertId = 0)
    }

    // MARK: - Query

    @Throws(Exception::class)
    fun query(statement: String, values: List<Any?> = emptyList()): List<Map<String, Any?>> = lock.withLock {
        SQLiteHelpers.query(requireOpen("query"), statement, values)
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
        SQLiteHelpers.vacuum(requireOpen("vacuum"))
    }

    // MARK: - Transactions
    // ReentrantLock is reentrant — beginTransaction inside runBatch won't deadlock.

    @Throws(Exception::class)
    fun beginTransaction(): Unit = lock.withLock {
        val handle = requireOpen("beginTransaction")
        if (handle.inTransaction()) {
            throw IllegalStateException("beginTransaction: a transaction is already active on '$name'")
        }
        handle.beginTransactionNonExclusive()
    }

    @Throws(Exception::class)
    fun commitTransaction(): Unit = lock.withLock {
        val handle = requireOpen("commitTransaction")
        check(handle.inTransaction()) { "commitTransaction: no transaction is active on '$name'" }
        SQLiteHelpers.commitTransaction(handle)
    }

    @Throws(Exception::class)
    fun rollbackTransaction(): Unit = lock.withLock {
        val handle = requireOpen("rollbackTransaction")
        check(handle.inTransaction()) { "rollbackTransaction: no transaction is active on '$name'" }
        SQLiteHelpers.rollbackTransaction(handle)
    }

    // MARK: - Migrations (called from open(), already holds lock)

    @Throws(Exception::class)
    private fun runMigrations(handle: SQLiteDatabase, migrations: List<MigrationEntry>) {
        val current = SQLiteHelpers.getUserVersion(handle)

        val pending = migrations
            .filter { it.version > current }
            .sortedBy { it.version }

        for (migration in pending) {
            handle.beginTransactionNonExclusive()
            try {
                for (sql in migration.statements) {
                    val trimmed = sql.trim()
                    handle.execSQL(trimmed)
                }
                SQLiteHelpers.setUserVersion(handle, migration.version)
                handle.setTransactionSuccessful()
            } catch (e: Exception) {
                handle.endTransaction()
                throw Exception("Migration v${migration.version} failed: ${e.message}")
            }
            handle.endTransaction()
        }
    }

    // MARK: - Private

    @Throws(IllegalStateException::class)
    private fun requireOpen(context: String): SQLiteDatabase {
        val handle = db
        check(handle != null && handle.isOpen) { "$context: '$name' is not open" }
        return handle
    }
}
