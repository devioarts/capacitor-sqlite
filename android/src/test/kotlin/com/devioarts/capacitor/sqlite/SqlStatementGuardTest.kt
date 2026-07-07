package com.devioarts.capacitor.sqlite

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

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
        assertThrows(IllegalArgumentException::class.java) {
            SQLiteHelpers.requireSingleStatement("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)")
        }
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
                "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE a SET x = 1; UPDATE b SET y = 2; END"
            )
        )
    }

    @Test
    fun doesNotMistakeBareBeginCaseIdentifierForTriggerBodyOpener() {
        // SQLite does not reserve BEGIN or CASE, so both are valid unquoted column/table
        // names. A naive "BEGIN/CASE anywhere but the first token opens a block" heuristic
        // would swallow the semicolon after these and hide the second statement.
        assertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(begin TEXT); DROP TABLE users"))
        assertTrue(
            SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(begin TEXT, end TEXT); DROP TABLE users")
        )
        assertThrows(IllegalArgumentException::class.java) {
            SQLiteHelpers.requireSingleStatement("CREATE TABLE t(begin TEXT); DROP TABLE users")
        }
        // Quoting still works as an explicit escape hatch.
        assertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(\"begin\" TEXT); DROP TABLE users"))
        // A qualified reference (NEW.begin in a trigger's WHEN clause) must not be mistaken
        // for the block-opening BEGIN either — the guard must still recognize the real one.
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg AFTER UPDATE ON t WHEN NEW.begin IS NOT NULL " +
                    "BEGIN INSERT INTO log VALUES (1); END"
            )
        )
        // Real trigger bodies and nested CASE expressions inside them keep working.
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END"
            )
        )
        assertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg_nested AFTER INSERT ON t BEGIN INSERT INTO log VALUES " +
                    "(CASE WHEN NEW.a THEN (CASE WHEN NEW.b THEN 1 ELSE 2 END) ELSE 3 END); END"
            )
        )
    }

    @Test
    fun classifiesStatementsAfterLeadingCommentsAndCtes() {
        assertTrue(SQLiteHelpers.statementType("/* lead */ INSERT INTO t VALUES (1)") == "INSERT")
        assertTrue(SQLiteHelpers.statementType("-- lead\nREPLACE INTO t VALUES (1)") == "REPLACE")
        assertTrue(SQLiteHelpers.statementType("WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte") == "INSERT")
        assertTrue(
            SQLiteHelpers.statementType(
                "WITH RECURSIVE cte(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cte WHERE x < 2) SELECT * FROM cte"
            ) == "SELECT"
        )
        assertTrue(
            SQLiteHelpers.statementType(
                "WITH one AS NOT MATERIALIZED (SELECT 1), two AS (SELECT 2) UPDATE t SET v = 1"
            ) == "UPDATE"
        )
    }
}
