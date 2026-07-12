package com.devioarts.capacitor.sqlite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BindValidationTest {

    @Test
    fun acceptsExactBindCount() {
        requireBindValueCount(expected = 2, received = 2)
    }

    @Test
    fun missingAndExtraValuesUseInvalidParams() {
        for (received in listOf(1, 3)) {
            val error = assertThrows(CapacitorSqliteException::class.java) {
                requireBindValueCount(expected = 2, received = received)
            }
            assertEquals("INVALID_PARAMS", error.code)
            assertEquals(
                "Bind value count mismatch: statement expects 2, received $received",
                error.message
            )
        }
    }
}
