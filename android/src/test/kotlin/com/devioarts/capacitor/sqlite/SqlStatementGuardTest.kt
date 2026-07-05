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
