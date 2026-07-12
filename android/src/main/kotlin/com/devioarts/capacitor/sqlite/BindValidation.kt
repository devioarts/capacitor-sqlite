package com.devioarts.capacitor.sqlite

/**
 * Validates positional bind arity using the public error taxonomy.
 *
 * Do not use Kotlin's `require` here: it produces IllegalArgumentException,
 * which the Capacitor boundary must otherwise misclassify as EXECUTE_FAILED.
 */
internal fun requireBindValueCount(
    expected: Int,
    received: Int,
) {
    if (received != expected) {
        throw CapacitorSqliteException(
            "INVALID_PARAMS",
            "Bind value count mismatch: statement expects $expected, received $received",
        )
    }
}
