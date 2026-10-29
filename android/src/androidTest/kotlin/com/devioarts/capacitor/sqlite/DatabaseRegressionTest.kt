package com.devioarts.capacitor.sqlite

import android.database.sqlite.SQLiteDatabase
import android.os.Build
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class DatabaseRegressionTest {
    private fun withDatabase(block: (Database) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.cacheDir, "audit-${System.nanoTime()}.db")
        val db = Database("audit", file.absolutePath)
        try {
            db.open()
            block(db)
        } finally {
            db.close()
            SQLiteDatabase.deleteDatabase(file)
        }
    }

    private fun fails(block: () -> Unit): Exception {
        try {
            block()
        } catch (expected: Exception) {
            return expected
        }
        throw AssertionError("Expected SQL failure")
    }

    private fun count(db: Database): Long = db.query("SELECT count(*) AS n FROM t")[0]["n"] as Long

    @Test
    fun preparationFailurePreservesManualTransaction() =
        withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v UNIQUE)"))
            db.beginTransaction()
            db.run("INSERT INTO t VALUES (1)")
            fails { db.run("INSERT OR ROLLBACK INTO missing_table VALUES (1)") }
            assertEquals(1L, count(db))
            db.commitTransaction()
            assertEquals(1L, count(db))
        }

    @Test
    fun schemaAndTriggerRollbackResetAndroidSession() {
        for (trigger in listOf(false, true)) withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v UNIQUE ON CONFLICT ROLLBACK)", "INSERT INTO t VALUES(1)"))
            if (trigger) db.execute(listOf("CREATE TRIGGER tr BEFORE INSERT ON t WHEN NEW.v=1 BEGIN SELECT RAISE(ROLLBACK, 'stop'); END"))
            db.beginTransaction()
            db.run("INSERT INTO t VALUES (2)")
            fails { db.run("INSERT INTO t VALUES (1)") }
            assertEquals(1L, count(db))
            db.beginTransaction()
            db.rollbackTransaction()
        }
    }

    @Test
    fun runManyCountsOnlyThisCallOnWalWriter() =
        withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v)"))
            db.run("INSERT INTO t VALUES (0)")
            for (transaction in listOf(true, false)) {
                assertEquals(2L, db.runMany("INSERT INTO t VALUES (?)", listOf(listOf(1), listOf(2)), transaction).changes)
                assertEquals(1L, db.runMany("INSERT INTO t VALUES (?)", listOf(listOf(3)), transaction, true).changes)
            }
            assertEquals(7L, count(db))
        }

    @Test
    fun batchCompilesAgainstSchemaAtExecutionTime() =
        withDatabase { db ->
            val result =
                db.runBatch(
                    listOf(
                        mapOf("statement" to "CREATE TABLE t(v)"),
                        mapOf("statement" to "INSERT INTO t VALUES (?)", "values" to listOf(1)),
                    ),
                )
            assertEquals(1L, result.changes)
            fails {
                db.runBatch(
                    listOf(
                        mapOf("statement" to "INSERT INTO t VALUES (2)"),
                        mapOf("statement" to "INSERT INTO t VALUES (?)", "values" to listOf(1, 2)),
                    ),
                    false,
                )
            }
            assertEquals(1L, count(db))
            fails {
                db.runBatch(
                    listOf(mapOf("statement" to "INSERT INTO t VALUES (2)"), mapOf("statement" to "INSERT INTO missing_table VALUES (1)")),
                )
            }
            assertEquals(1L, count(db))
        }

    @Test
    fun rawTransactionControlRemainsCompatibleWithApi() =
        withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v)"))
            db.execute(listOf("BEGIN"), false)
            db.run("INSERT INTO t VALUES (1)")
            db.rollbackTransaction()
            assertEquals(0L, count(db))
            db.beginTransaction()
            assertEquals(0L, db.run("COMMIT").changes)
            assertEquals(0L, db.run("BEGIN").changes)
            db.rollbackTransaction()
            fails { db.execute(listOf("INSERT INTO t VALUES (2)", "COMMIT", "INSERT INTO missing_table VALUES (1)")) }
            assertEquals(0L, count(db))
        }

    @Test
    fun returningDoesNotReplayWhenRowsExceedCursorWindow() =
        withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v INTEGER, payload BLOB)"))
            db.runMany("INSERT INTO t VALUES (0, zeroblob(262144))", List(16) { emptyList() })
            db.beginTransaction()
            db.run("INSERT INTO t VALUES (7, zeroblob(0))")
            if (Build.VERSION.SDK_INT >= 35) {
                val result = db.query("UPDATE t SET v=v+1 WHERE v=0 RETURNING v,payload")
                assertEquals(16, result.size)
                assertTrue(result.all { it["v"] == 1L })
                assertEquals(16L, db.query("SELECT count(*) AS n FROM t WHERE v=1")[0]["n"])
            } else {
                val error = fails { db.query("UPDATE t SET v=v+1 WHERE v=0 RETURNING v,payload") }
                assertEquals("QUERY_FAILED", (error as CapacitorSqliteException).code)
                assertTrue(error.message.orEmpty().contains("CursorWindow"))
                assertEquals(16L, db.query("SELECT count(*) AS n FROM t WHERE v=0")[0]["n"])
            }
            assertEquals(1L, db.query("SELECT count(*) AS n FROM t WHERE v=7")[0]["n"])
            db.rollbackTransaction()
        }

    @Test
    fun singleRowReturningAndUnicodeIdentifiers() =
        withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v, a\$b)"))
            assertEquals(1L, db.query("INSERT INTO t VALUES (?, ?) RETURNING v", listOf(1, "text"))[0]["v"])
            assertEquals("text", db.query("SELECT a\$b FROM t")[0]["a\$b"])
            assertEquals(1L, db.query("WITH český AS (SELECT 1 AS n) SELECT n FROM český")[0]["n"])
        }

    @Test
    fun preflightNeverPreparesSideEffectingPragmas() =
        withDatabase { db ->
            fails { db.runMany("PRAGMA foreign_keys=OFF", listOf(emptyList(), listOf(1))) }
            fails { db.runBatch(listOf(mapOf("statement" to "PRAGMA foreign_keys=OFF"), mapOf("statement" to "SELECT ?"))) }
            assertEquals(1L, db.query("PRAGMA foreign_keys")[0]["foreign_keys"])
            db.beginTransaction()
            fails { db.runMany("PRAGMA foreign_keys=OFF", listOf(emptyList())) }
            db.rollbackTransaction()
            assertEquals(1L, db.query("PRAGMA foreign_keys")[0]["foreign_keys"])
        }

    @Test
    fun everyManualWritePathRecoversSchemaRollback() {
        for (operation in 0..4) withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v UNIQUE ON CONFLICT ROLLBACK)", "INSERT INTO t VALUES(1)"))
            db.beginTransaction()
            db.run("INSERT INTO t VALUES(2)")
            val sql = "INSERT INTO t VALUES(1)"
            fails {
                when (operation) {
                    0 -> db.run(sql)
                    1 -> db.execute(listOf(sql), false)
                    2 -> db.runBatch(listOf(mapOf("statement" to sql)), false)
                    3 -> db.runMany(sql, listOf(emptyList()), false)
                    else -> db.query("$sql RETURNING v")
                }
            }
            assertEquals(1L, count(db))
            db.beginTransaction()
            db.rollbackTransaction()
        }
    }

    @Test
    fun migrationControlIsRejectedBeforeEarlierVersionsCommit() =
        withDatabase { db ->
            for (control in listOf("COMMIT", "\uFEFFCOMMIT")) {
                fails { db.open(listOf(MigrationEntry(1, listOf("CREATE TABLE migration_leak(v)")), MigrationEntry(2, listOf(control)))) }
                assertEquals(0, db.getSchemaVersion())
                assertEquals(0L, db.query("SELECT count(*) AS n FROM sqlite_master WHERE name='migration_leak'")[0]["n"])
            }
        }

    @Test
    fun emptyReturningHasNoRows() =
        withDatabase { db ->
            db.execute(listOf("CREATE TABLE t(v)"))
            assertTrue(db.query("UPDATE t SET v=1 RETURNING v").isEmpty())
        }

    @Test
    fun deferredConstraintCommitFailureDoesNotStrandConnection() =
        withDatabase { db ->
            db.execute(
                listOf(
                    "CREATE TABLE parent(id PRIMARY KEY)",
                    "CREATE TABLE t(v REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
                    "CREATE TEMP TABLE user_temp(v)",
                    "INSERT INTO user_temp VALUES(8)",
                ),
            )
            db.beginTransaction()
            db.run("INSERT INTO t VALUES(1)")
            fails { db.commitTransaction() }
            assertEquals(0L, count(db))
            db.beginTransaction()
            assertEquals(8L, db.query("SELECT v FROM user_temp")[0]["v"])
            assertEquals(0L, db.query("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE '__capacitor_rollback_%'")[0]["n"])
            db.rollbackTransaction()
            fails { db.run("INSERT INTO t VALUES(1)") }
            assertEquals(0L, count(db))
            db.beginTransaction()
            db.rollbackTransaction()
        }

    @Test
    fun failedRecoveryClosesHandleAndReopenClearsStatementCache() =
        withDatabase { db ->
            db.execute(
                listOf(
                    "CREATE TABLE parent(id PRIMARY KEY)",
                    "CREATE TABLE t(v REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
                ),
            )
            db.beginTransaction()
            db.run("INSERT INTO t VALUES(?)", listOf(1))
            db.query("PRAGMA query_only=ON")
            fails { db.commitTransaction() }
            assertTrue(!db.isOpen)
            db.open()
            db.run("INSERT INTO parent VALUES(1)")
            db.run("INSERT INTO t VALUES(?)", listOf(1))
            assertEquals(1L, count(db))
        }
}
