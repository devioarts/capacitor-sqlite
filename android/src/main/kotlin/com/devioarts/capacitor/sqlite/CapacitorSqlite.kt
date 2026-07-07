package com.devioarts.capacitor.sqlite

import android.content.Context
import android.os.Environment
import java.io.File

internal class CapacitorSqliteException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

internal class CapacitorSqlite(private val context: Context) {

    private val databases = HashMap<String, Database>()

    // MARK: - isAvailable

    fun isAvailable(): Boolean = true

    // MARK: - open

    @Throws(Exception::class)
    fun open(database: String, readonly: Boolean, directory: String?, migrations: List<Map<String, Any?>>) {
        if (database != ":memory:" && !database.matches(Regex("^[A-Za-z0-9_-]+\$"))) {
            throw CapacitorSqliteException(
                "INVALID_NAME",
                "Invalid database name '$database'. Use only A-Z, a-z, 0-9, _ or -"
            )
        }
        val path = if (database == ":memory:") ":memory:" else databasePath(database, directory)
        // Throws on malformed entries — no silent drops.
        val entries = parseMigrations(migrations)
        if (readonly && entries.isNotEmpty()) {
            throw CapacitorSqliteException("MIGRATION_FAILED", "Migrations cannot run when readonly is true")
        }

        // Atomically get-or-create the Database instance.
        // Storing before open() ensures concurrent callers share the same instance,
        // and Database.open() is idempotent (serialized by its ReentrantLock).
        val db = synchronized(this) {
            val existing = databases[database]
            if (existing != null) {
                if (existing.readonly != readonly || existing.path != path) {
                    throw CapacitorSqliteException(
                        "DB_ALREADY_OPEN",
                        "open: '$database' is already open with a different readonly mode or directory"
                    )
                }
                existing
            } else {
                Database(name = database, path = path, readonly = readonly).also {
                    databases[database] = it
                }
            }
        }

        try {
            db.open(entries)
        } catch (e: CapacitorSqliteException) {
            removeFailedOpen(database, db)
            throw e
        } catch (e: Exception) {
            removeFailedOpen(database, db)
            throw CapacitorSqliteException("OPEN_FAILED", e.message ?: "open failed", e)
        }
    }

    // MARK: - close

    @Throws(Exception::class)
    fun close(database: String) {
        wrap("CLOSE_FAILED") {
            synchronized(this) {
                val db = databases[database]
                    ?: throw CapacitorSqliteException("DB_NOT_OPEN", "close: '$database' is not open")
                db.close()
                if (databases[database] === db) {
                    databases.remove(database)
                }
            }
        }
    }

    fun closeAll() {
        val openDatabases = synchronized(this) {
            databases.values.toList().also { databases.clear() }
        }
        for (db in openDatabases) {
            try {
                db.close()
            } catch (_: Exception) {
                // Best-effort lifecycle cleanup; explicit close(database) reports errors.
            }
        }
    }

    // MARK: - isOpen

    fun isOpen(database: String): Boolean =
        synchronized(this) { databases[database]?.isOpen } ?: false

    // MARK: - getVersion

    @Throws(Exception::class)
    fun getVersion(database: String): String =
        wrap("VERSION_FAILED") { requireOpen(database, "getVersion").getVersion() }

    @Throws(Exception::class)
    fun getSchemaVersion(database: String): Int =
        wrap("SCHEMA_VERSION_FAILED") { requireOpen(database, "getSchemaVersion").getSchemaVersion() }

    // MARK: - vacuum

    @Throws(Exception::class)
    fun vacuum(database: String) =
        wrap("VACUUM_FAILED") { requireOpen(database, "vacuum").vacuum() }

    // MARK: - execute

    @Throws(Exception::class)
    fun execute(database: String, statements: List<String>, transaction: Boolean): Long =
        wrap("EXECUTE_FAILED") { requireOpen(database, "execute").execute(statements, transaction) }

    // MARK: - run

    @Throws(Exception::class)
    fun run(database: String, statement: String, values: List<Any?>): RunResult =
        wrap("EXECUTE_FAILED") { requireOpen(database, "run").run(statement, values) }

    // MARK: - runBatch

    @Throws(Exception::class)
    fun runBatch(database: String, set: List<Map<String, Any?>>, transaction: Boolean): RunResult =
        wrap("EXECUTE_FAILED") { requireOpen(database, "runBatch").runBatch(set, transaction) }

    // MARK: - query

    @Throws(Exception::class)
    fun query(database: String, statement: String, values: List<Any?>): List<Map<String, Any?>> =
        wrap("QUERY_FAILED") { requireOpen(database, "query").query(statement, values) }

    // MARK: - transactions

    @Throws(Exception::class)
    fun beginTransaction(database: String) =
        wrap("TRANSACTION_FAILED") { requireOpen(database, "beginTransaction").beginTransaction() }

    @Throws(Exception::class)
    fun commitTransaction(database: String) =
        wrap("TRANSACTION_FAILED") { requireOpen(database, "commitTransaction").commitTransaction() }

    @Throws(Exception::class)
    fun rollbackTransaction(database: String) =
        wrap("TRANSACTION_FAILED") { requireOpen(database, "rollbackTransaction").rollbackTransaction() }

    // MARK: - Private helpers

    @Throws(IllegalStateException::class)
    private fun requireOpen(name: String, context: String): Database {
        val db = synchronized(this) { databases[name] }
        if (db == null || !db.isOpen) {
            throw CapacitorSqliteException("DB_NOT_OPEN", "$context: '$name' is not open")
        }
        return db
    }

    private inline fun <T> wrap(fallbackCode: String, block: () -> T): T {
        try {
            return block()
        } catch (e: CapacitorSqliteException) {
            throw e
        } catch (e: Exception) {
            throw CapacitorSqliteException(fallbackCode, e.message ?: "SQLite operation failed", e)
        }
    }

    private fun removeFailedOpen(database: String, db: Database) {
        synchronized(this) {
            // Only remove the instance that failed. A concurrent retry may already
            // have replaced the map entry after the failed open released its lock.
            if (databases[database] === db && !db.isOpen) {
                databases.remove(database)
            }
        }
    }

    private fun databasePath(name: String, directory: String?): String {
        // Keep this mapping aligned with OpenOptions.directory documentation.
        // Raw paths are intentionally not accepted across the bridge.
        val base = when (directory ?: "default") {
            "default", "library" -> context.filesDir
            "documents" -> context.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS)
                ?: File(context.filesDir, "Documents")
            "cache" -> context.cacheDir
            else -> throw CapacitorSqliteException(
                "INVALID_PARAMS",
                "Invalid directory '$directory'. Use default, documents, library or cache"
            )
        }
        val dir = File(base, "CapacitorSQLite")
        dir.mkdirs()
        return File(dir, "$name.db").absolutePath
    }

    /// Parses migration definitions; throws on any malformed entry instead of silently dropping it.
    private fun parseMigrations(raw: List<Map<String, Any?>>): List<MigrationEntry> {
        val seenVersions = mutableSetOf<Int>()
        return raw.mapIndexed { index, item ->
            val version = parseMigrationVersion(item["version"], index)
            if (!seenVersions.add(version)) {
                throw CapacitorSqliteException("MIGRATION_FAILED", "Migration at index $index: duplicate version $version")
            }
            val rawStatements = item["statements"] as? List<*>
            if (rawStatements.isNullOrEmpty()) {
                throw CapacitorSqliteException(
                    "MIGRATION_FAILED",
                    "Migration at index $index: 'statements' must be a non-empty [String]"
                )
            }
            val statements = rawStatements.mapIndexed { statementIndex, statement ->
                if (statement !is String || statement.trim().isEmpty()) {
                    throw CapacitorSqliteException(
                        "MIGRATION_FAILED",
                        "Migration at index $index: statements[$statementIndex] must be a non-empty string"
                    )
                }
                statement
            }
            MigrationEntry(version, statements)
        }
    }

    // SQLite's `PRAGMA user_version` is stored in a 32-bit signed field in the database
    // header, and Kotlin's Int is 32-bit too, so the Int.MAX_VALUE cap below is a real
    // ceiling, not just a sanity check. Web/Electron (isValidMigrationVersion in
    // migrations.ts) and iOS (maxMigrationVersion in CapacitorSqlite+Helpers.swift) enforce
    // the same numeric limit for cross-platform consistency.
    private fun parseMigrationVersion(value: Any?, index: Int): Int {
        val number = value as? Number
        val version = number?.toDouble()
        if (version == null ||
            !version.isFinite() ||
            version % 1.0 != 0.0 ||
            version <= 0.0 ||
            version > Int.MAX_VALUE.toDouble()
        ) {
            throw CapacitorSqliteException(
                "MIGRATION_FAILED",
                "Migration at index $index: 'version' must be a positive integer"
            )
        }
        return version.toInt()
    }
}
