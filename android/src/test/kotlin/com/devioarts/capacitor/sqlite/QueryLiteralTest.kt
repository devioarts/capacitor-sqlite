package com.devioarts.capacitor.sqlite

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class QueryLiteralTest {
    @Test
    fun numericLiteralsDoNotTurnMinusIntoAComment() {
        for (value in listOf(-1, -1L, (-1).toShort(), (-1).toByte(), -1.5, -1.5f)) {
            val (sql, values) = SQLiteHelpers.injectLiterals("SELECT 1-? AS a, -? AS b", listOf(value, value))
            assertEquals("SELECT 1-($value) AS a, -($value) AS b", sql)
            assertEquals(emptyList<Any?>(), values)
        }
    }
}
