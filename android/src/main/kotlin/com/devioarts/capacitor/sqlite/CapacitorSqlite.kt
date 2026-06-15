package com.devioarts.capacitor.sqlite

import android.content.Context
import java.io.File

internal class CapacitorSqlite(private val context: Context) {

    private val databases = HashMap<String, Database>()

    // MARK: - isAvailable

    fun isAvailable(): Boolean = true

    // MARK: - open

    @Throws(Exception::class)
    fun open(database: String, readonly: Boolean, directory: String?, migrations: List<Map<String, Any?>>) {
        require(database == ":memory:" || database.matches(Regex("^[A-Za-z0-9_-]+\$"))) {
            "Invalid database name '$database'. Use only A–Z, a–z, 0–9, _ or -"
        }
        val path = if (database == ":memory:") ":memory:" else databasePath(database, directory)
        // Throws on malformed entries — no silent drops.
        val entries = parseMigrations(migrations)

        // Atomically get-or-create the Database instance.
        // Storing before open() ensures concurrent callers share the same instance,
        // and Database.open() is idempotent (serialized by its ReentrantLock).
        val db = synchronized(this) {
            val existing = databases[database]
            if (existing != null) {
                require(existing.readonly == readonly) {
                    "open: '$database' is already open with a different readonly mode"
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
        } catch (e: Exception) {
            // Remove from map so a retry can create a fresh instance.
            synchronized(this) { databases.remove(database) }
            throw e
        }
    }

    // MARK: - close

    @Throws(Exception::class)
    fun close(database: String) {
        val db = synchronized(this) { databases.remove(database) }
            ?: throw IllegalStateException("close: '$database' is not open")

        db.close()
    }

    // MARK: - isOpen

    fun isOpen(database: String): Boolean =
        synchronized(this) { databases[database]?.isOpen } ?: false

    // MARK: - getVersion

    @Throws(Exception::class)
    fun getVersion(database: String): String =
        requireOpen(database, "getVersion").getVersion()

    @Throws(Exception::class)
    fun getSchemaVersion(database: String): Int =
        requireOpen(database, "getSchemaVersion").getSchemaVersion()

    // MARK: - vacuum

    @Throws(Exception::class)
    fun vacuum(database: String) =
        requireOpen(database, "vacuum").vacuum()

    // MARK: - execute

    @Throws(Exception::class)
    fun execute(database: String, statements: List<String>, transaction: Boolean): Long =
        requireOpen(database, "execute").execute(statements, transaction)

    // MARK: - run

    @Throws(Exception::class)
    fun run(database: String, statement: String, values: List<Any?>): RunResult =
        requireOpen(database, "run").run(statement, values)

    // MARK: - runBatch

    @Throws(Exception::class)
    fun runBatch(database: String, set: List<Map<String, Any?>>, transaction: Boolean): RunResult =
        requireOpen(database, "runBatch").runBatch(set, transaction)

    // MARK: - query

    @Throws(Exception::class)
    fun query(database: String, statement: String, values: List<Any?>): List<Map<String, Any?>> =
        requireOpen(database, "query").query(statement, values)

    // MARK: - transactions

    @Throws(Exception::class)
    fun beginTransaction(database: String) =
        requireOpen(database, "beginTransaction").beginTransaction()

    @Throws(Exception::class)
    fun commitTransaction(database: String) =
        requireOpen(database, "commitTransaction").commitTransaction()

    @Throws(Exception::class)
    fun rollbackTransaction(database: String) =
        requireOpen(database, "rollbackTransaction").rollbackTransaction()

    // MARK: - Private helpers

    @Throws(IllegalStateException::class)
    private fun requireOpen(name: String, context: String): Database {
        val db = synchronized(this) { databases[name] }
        check(db != null && db.isOpen) { "$context: '$name' is not open" }
        return db
    }

    private fun databasePath(name: String, directory: String?): String {
        val dir = if (directory != null) File(directory) else File(context.filesDir, "CapacitorSQLite")
        dir.mkdirs()
        return File(dir, "$name.db").absolutePath
    }

    /// Parses migration definitions; throws on any malformed entry instead of silently dropping it.
    private fun parseMigrations(raw: List<Map<String, Any?>>): List<MigrationEntry> =
        raw.mapIndexed { index, item ->
            val version = (item["version"] as? Number)?.toInt()
            require(version != null && version > 0) {
                "Migration at index $index: 'version' must be a positive integer"
            }
            val rawStatements = item["statements"] as? List<*>
            require(!rawStatements.isNullOrEmpty()) {
                "Migration at index $index: 'statements' must be a non-empty [String]"
            }
            val statements = rawStatements.mapIndexed { statementIndex, statement ->
                require(statement is String && statement.trim().isNotEmpty()) {
                    "Migration at index $index: statements[$statementIndex] must be a non-empty string"
                }
                statement
            }
            MigrationEntry(version, statements)
        }
}
