package com.devioarts.capacitor.sqlite

import com.getcapacitor.Logger

class CapacitorSqlite {

    fun echo(value: String): String {
        Logger.info("Echo", value)

        return value
    }
}
