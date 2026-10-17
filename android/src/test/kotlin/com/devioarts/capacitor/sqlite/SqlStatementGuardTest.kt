package com.devioarts.capacitor.sqlite

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SqlStatementGuardTest {
    @Test
    fun allowsSingleStatementWithTrailingSemicolonsAndComments() {
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1;"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1; ; -- done"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT ';' AS semi; /* done */"))
    }

    @Test
    fun ignoresSemicolonsInsideStringsIdentifiersAndComments() {
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 'a; b'"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT \"semi;name\" FROM t"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT [semi;name] FROM t"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1 /* ; */"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1 -- ;\n"))
    }

    @Test
    fun rejectsMultipleStatementsAfterRealSemicolon() {
        assertTrue(SQLiteHelpers.hasMultipleStatements("SELECT 1; SELECT 2"))
        assertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE a(id); CREATE TABLE b(id)"))
        val error =
            assertThrows(CapacitorSqliteException::class.java) {
                SQLiteHelpers.requireSingleStatement("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)")
            }
        assertTrue(error.code == "INVALID_PARAMS")
    }

    @Test
    fun leadingBeginTransactionDoesNotMaskFollowingStatement() {
        // A leading BEGIN is a transaction statement, not a trigger-body opener.
        assertTrue(SQLiteHelpers.hasMultipleStatements("BEGIN; DROP TABLE t"))
        assertTrue(SQLiteHelpers.hasMultipleStatements("BEGIN TRANSACTION; DROP TABLE t; COMMIT"))
        assertTrue(SQLiteHelpers.hasMultipleStatements("/* lead */ BEGIN; DROP TABLE t"))
        // Standalone transaction statements stay single.
        assertFalse(SQLiteHelpers.hasMultipleStatements("BEGIN"))
        assertFalse(SQLiteHelpers.hasMultipleStatements("BEGIN TRANSACTION;"))
        // Trigger bodies (BEGIN not at statement start) keep working.
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE a SET x = 1; UPDATE b SET y = 2; END",
            ),
        )
    }

    @Test
    fun doesNotMistakeBareBeginCaseIdentifierForTriggerBodyOpener() {
        // SQLite does not reserve BEGIN or CASE, so both are valid unquoted column/table
        // names. A naive "BEGIN/CASE anywhere but the first token opens a block" heuristic
        // would swallow the semicolon after these and hide the second statement.
        assertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(begin TEXT); DROP TABLE users"))
        assertTrue(
            SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(begin TEXT, end TEXT); DROP TABLE users"),
        )
        val error =
            assertThrows(CapacitorSqliteException::class.java) {
                SQLiteHelpers.requireSingleStatement("CREATE TABLE t(begin TEXT); DROP TABLE users")
            }
        assertTrue(error.code == "INVALID_PARAMS")
        // Quoting still works as an explicit escape hatch.
        assertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(\"begin\" TEXT); DROP TABLE users"))
        // A qualified reference (NEW.begin in a trigger's WHEN clause) must not be mistaken
        // for the block-opening BEGIN either — the guard must still recognize the real one.
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg AFTER UPDATE ON t WHEN NEW.begin IS NOT NULL " +
                    "BEGIN INSERT INTO log VALUES (1); END",
            ),
        )
        // Real trigger bodies and nested CASE expressions inside them keep working.
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END",
            ),
        )
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg_nested AFTER INSERT ON t BEGIN INSERT INTO log VALUES " +
                    "(CASE WHEN NEW.a THEN (CASE WHEN NEW.b THEN 1 ELSE 2 END) ELSE 3 END); END",
            ),
        )
    }

    @Test
    fun classifiesStatementsAfterLeadingCommentsAndCtes() {
        assertTrue(SQLiteHelpers.statementType("/* lead */ INSERT INTO t VALUES (1)") == "INSERT")
        assertTrue(SQLiteHelpers.statementType("-- lead\nREPLACE INTO t VALUES (1)") == "REPLACE")
        assertTrue(SQLiteHelpers.statementType("WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte") == "INSERT")
        assertTrue(
            SQLiteHelpers.statementType(
                "WITH RECURSIVE cte(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cte WHERE x < 2) SELECT * FROM cte",
            ) == "SELECT",
        )
        assertTrue(
            SQLiteHelpers.statementType(
                "WITH one AS NOT MATERIALIZED (SELECT 1), two AS (SELECT 2) UPDATE t SET v = 1",
            ) == "UPDATE",
        )
    }

    @Test
    fun detectsUpsertConflictClauseSoRunAvoidsStaleLastInsertId() {
        assertTrue(SQLiteHelpers.hasConflictClause("INSERT INTO t VALUES (1) ON CONFLICT(id) DO UPDATE SET v = 1"))
        assertTrue(SQLiteHelpers.hasConflictClause("INSERT INTO t VALUES (1) ON CONFLICT(id) DO NOTHING"))
        assertFalse(SQLiteHelpers.hasConflictClause("INSERT OR REPLACE INTO t VALUES (1)"))
        assertFalse(SQLiteHelpers.hasConflictClause("INSERT OR IGNORE INTO t VALUES (1)"))
        assertFalse(SQLiteHelpers.hasConflictClause("INSERT INTO t VALUES (1)"))
        assertFalse(SQLiteHelpers.hasConflictClause("UPDATE t SET v = 1"))
        // The word must be a real keyword, not text inside a string/quoted identifier/comment.
        assertFalse(SQLiteHelpers.hasConflictClause("INSERT INTO t (note) VALUES ('ON CONFLICT nice')"))
        assertFalse(SQLiteHelpers.hasConflictClause("INSERT INTO t (\"conflict\") VALUES (1)"))
        assertFalse(SQLiteHelpers.hasConflictClause("INSERT INTO t VALUES (1) /* on conflict */"))
    }

    @Test
    fun detectsOrRollbackOnlyAsAdjacentSqlKeywords() {
        assertTrue(SQLiteHelpers.hasRollbackConflictClause("INSERT OR ROLLBACK INTO t VALUES (1)"))
        assertTrue(SQLiteHelpers.hasRollbackConflictClause("UPDATE OR /* gap */ ROLLBACK t SET v = 1"))
        assertFalse(SQLiteHelpers.hasRollbackConflictClause("SELECT 'OR ROLLBACK'"))
        assertFalse(SQLiteHelpers.hasRollbackConflictClause("SELECT or_rollback FROM t"))
        assertFalse(SQLiteHelpers.hasRollbackConflictClause("SELECT 1 -- OR ROLLBACK\n"))
        assertFalse(SQLiteHelpers.hasRollbackConflictClause("INSERT OR IGNORE INTO t VALUES (1)"))
    }

    @Test
    fun qualifiedNewEndDoesNotCloseTriggerBodyEarly() {
        val trigger =
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES " +
                "(NEW.end); INSERT INTO log VALUES (2); END"
        assertFalse(SQLiteHelpers.hasMultipleStatements(trigger))
        assertTrue(SQLiteHelpers.hasMultipleStatements("$trigger; SELECT 1"))
    }

    @Test
    fun keywordIdentifiersAndTriggerTerminatorsPreserveBoundaries() {
        val ordinary =
            listOf(
                "SELECT begin FROM t",
                "SELECT end FROM t",
                "SELECT t . begin FROM t",
                "UPDATE t SET begin = 1",
                "DELETE FROM begin",
                "DROP TABLE begin",
                "CREATE TABLE begin(begin INTEGER, end INTEGER)",
                "SELECT CASE WHEN 1 THEN 2 ELSE 3 END",
            )
        val triggers =
            listOf(
                "CREATE TRIGGER begin AFTER INSERT ON t BEGIN SELECT 1; END",
                "CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN SELECT end FROM t; SELECT begin FROM t; END",
                "CREATE TEMPORARY TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; /* gap */ END",
                "CREATE TRIGGER tr AFTER UPDATE OF begin,end ON t WHEN NEW.begin > 0 BEGIN SELECT NEW.end; END",
                "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN NEW.begin THEN " +
                    "CASE WHEN NEW.end THEN 1 ELSE 2 END ELSE 3 END; END",
                "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT '; END;', \"begin\", `end`, [case]; END",
                "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; -- END; hidden\nSELECT 2; END",
                "EXPLAIN CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
                "EXPLAIN QUERY PLAN CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
            )
        for (sql in ordinary) {
            assertFalse(SQLiteHelpers.hasMultipleStatements("/* lead */ $sql; -- done"), sql)
            assertTrue(SQLiteHelpers.hasMultipleStatements("$sql; /* gap */ DELETE FROM t"), sql)
        }
        for (sql in triggers) {
            assertFalse(SQLiteHelpers.hasMultipleStatements("/* lead */ $sql; /* done */"), sql)
            assertTrue(SQLiteHelpers.hasMultipleStatements("$sql; /* gap */ DELETE FROM t"), sql)
        }
    }
}
