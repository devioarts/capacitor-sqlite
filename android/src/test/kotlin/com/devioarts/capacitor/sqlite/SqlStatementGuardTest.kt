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
}
