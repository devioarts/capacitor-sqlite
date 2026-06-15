package com.devioarts.capacitor.sqlite

import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(name = "CapacitorSqlite")
class CapacitorSqlitePlugin : Plugin() {

    private lateinit var impl: CapacitorSqlite

    override fun load() {
        impl = CapacitorSqlite(context)
    }

    // MARK: - Unified response helpers

    private fun success(call: PluginCall, data: JSObject = JSObject()) {
        call.resolve(JSObject().put("success", true).put("data", data))
    }

    private fun failure(call: PluginCall, code: String, message: String, method: String) {
        call.resolve(
            JSObject()
                .put("success", false)
                .put("error", JSObject()
                    .put("code", code)
                    .put("message", message)
                    .put("platform", "android")
                    .put("method", method)
                    .put("details", JSObject())
                )
        )
    }

    private fun errorCode(e: Exception, fallback: String): String {
        val message = e.message.orEmpty()
        return when {
            message.contains("not open") -> "DB_NOT_OPEN"
            message.contains("Invalid directory") -> "INVALID_PARAMS"
            message.contains("placeholder") -> "INVALID_PARAMS"
            message.contains("bind values") -> "INVALID_PARAMS"
            message.contains("Unsupported query value type") -> "INVALID_PARAMS"
            message.contains("Numeric bind value") -> "INVALID_PARAMS"
            message.contains("Invalid database name") -> "INVALID_NAME"
            message.contains("already open") -> "DB_ALREADY_OPEN"
            message.contains("transaction is already active") -> "TRANSACTION_FAILED"
            message.contains("no transaction is active") -> "TRANSACTION_FAILED"
            else -> fallback
        }
    }

    // MARK: - getPlatform

    @PluginMethod
    fun getPlatform(call: PluginCall) {
        success(call, JSObject().put("platform", "android"))
    }

    // MARK: - isAvailable

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        success(call, JSObject().put("available", impl.isAvailable()))
    }

    // MARK: - open

    @PluginMethod
    fun open(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "open")
        val readonly = call.getBoolean("readonly", false) ?: false
        val directory = call.getString("directory")
        val migrations = try {
            jsonArrayToListOfMaps(call.getArray("migrations"), "migrations")
        } catch (e: IllegalArgumentException) {
            return failure(call, "MIGRATION_FAILED", e.message ?: "Invalid migrations", "open")
        }

        bridge.execute {
            try {
                impl.open(database, readonly, directory, migrations)
                success(call)
            } catch (e: Exception) {
                val code = if (e.message?.contains("Migration") == true) "MIGRATION_FAILED" else "OPEN_FAILED"
                failure(call, errorCode(e, code), e.message ?: "open failed", "open")
            }
        }
    }

    // MARK: - close

    @PluginMethod
    fun close(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "close")

        bridge.execute {
            try {
                impl.close(database)
                success(call)
            } catch (e: Exception) {
                failure(call, errorCode(e, "CLOSE_FAILED"), e.message ?: "close failed", "close")
            }
        }
    }

    // MARK: - isOpen

    @PluginMethod
    fun isOpen(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "isOpen")
        success(call, JSObject().put("open", impl.isOpen(database)))
    }

    // MARK: - getVersion

    @PluginMethod
    fun getVersion(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "getVersion")

        bridge.execute {
            try {
                val version = impl.getVersion(database)
                success(call, JSObject().put("version", version))
            } catch (e: Exception) {
                failure(call, errorCode(e, "VERSION_FAILED"), e.message ?: "getVersion failed", "getVersion")
            }
        }
    }

    // MARK: - getSchemaVersion

    @PluginMethod
    fun getSchemaVersion(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "getSchemaVersion")

        bridge.execute {
            try {
                val version = impl.getSchemaVersion(database)
                success(call, JSObject().put("version", version))
            } catch (e: Exception) {
                failure(
                    call,
                    errorCode(e, "SCHEMA_VERSION_FAILED"),
                    e.message ?: "getSchemaVersion failed",
                    "getSchemaVersion"
                )
            }
        }
    }

    // MARK: - vacuum

    @PluginMethod
    fun vacuum(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "vacuum")

        bridge.execute {
            try {
                impl.vacuum(database)
                success(call)
            } catch (e: Exception) {
                failure(call, errorCode(e, "VACUUM_FAILED"), e.message ?: "vacuum failed", "vacuum")
            }
        }
    }

    // MARK: - execute

    @PluginMethod
    fun execute(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "execute")
        val stmts = try {
            jsonArrayToStringList(call.getArray("statements"), "statements")
        } catch (e: IllegalArgumentException) {
            return failure(call, "INVALID_PARAMS", e.message ?: "Invalid statements", "execute")
        }
        if (stmts.isEmpty()) {
            return failure(call, "INVALID_PARAMS", "'statements' must be a non-empty [string]", "execute")
        }
        val transaction = call.getBoolean("transaction", true) ?: true

        bridge.execute {
            try {
                val changes = impl.execute(database, stmts, transaction)
                success(call, JSObject().put("changes", changes))
            } catch (e: Exception) {
                failure(call, errorCode(e, "EXECUTE_FAILED"), e.message ?: "execute failed", "execute")
            }
        }
    }

    // MARK: - run

    @PluginMethod
    fun run(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "run")
        val statement = call.getString("statement")
            ?: return failure(call, "INVALID_PARAMS", "'statement' is required", "run")
        if (statement.trim().isEmpty()) {
            return failure(call, "INVALID_PARAMS", "'statement' is required", "run")
        }
        val values = try {
            jsonArrayToValueList(call.getArray("values"), "values")
        } catch (e: IllegalArgumentException) {
            return failure(call, "INVALID_PARAMS", e.message ?: "Invalid values", "run")
        }

        bridge.execute {
            try {
                val result = impl.run(database, statement, values)
                success(call, JSObject().put("changes", result.changes).put("lastInsertId", result.lastInsertId))
            } catch (e: Exception) {
                failure(call, errorCode(e, "EXECUTE_FAILED"), e.message ?: "run failed", "run")
            }
        }
    }

    // MARK: - runBatch

    @PluginMethod
    fun runBatch(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "runBatch")
        val set = try {
            jsonArrayToListOfMaps(call.getArray("set"), "set")
        } catch (e: IllegalArgumentException) {
            return failure(call, "INVALID_PARAMS", e.message ?: "Invalid set", "runBatch")
        }
        if (set.isEmpty()) {
            return failure(call, "INVALID_PARAMS", "'set' must be a non-empty array", "runBatch")
        }
        val transaction = call.getBoolean("transaction", true) ?: true

        bridge.execute {
            try {
                val result = impl.runBatch(database, set, transaction)
                success(call, JSObject().put("changes", result.changes).put("lastInsertId", result.lastInsertId))
            } catch (e: Exception) {
                failure(call, errorCode(e, "EXECUTE_FAILED"), e.message ?: "runBatch failed", "runBatch")
            }
        }
    }

    // MARK: - query

    @PluginMethod
    fun query(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "query")
        val statement = call.getString("statement")
            ?: return failure(call, "INVALID_PARAMS", "'statement' is required", "query")
        if (statement.trim().isEmpty()) {
            return failure(call, "INVALID_PARAMS", "'statement' is required", "query")
        }
        val values = try {
            jsonArrayToValueList(call.getArray("values"), "values")
        } catch (e: IllegalArgumentException) {
            return failure(call, "INVALID_PARAMS", e.message ?: "Invalid values", "query")
        }

        bridge.execute {
            try {
                val rows = impl.query(database, statement, values)
                val result = JSArray()
                for (row in rows) {
                    val obj = JSObject()
                    for ((key, value) in row) {
                        when (value) {
                            null         -> obj.put(key, JSONObject.NULL)
                            is ByteArray -> obj.put(key, SQLiteHelpers.BLOB_PREFIX + Base64.encodeToString(value, Base64.NO_WRAP))
                            else         -> obj.put(key, value)
                        }
                    }
                    result.put(obj)
                }
                success(call, JSObject().put("rows", result))
            } catch (e: Exception) {
                failure(call, errorCode(e, "QUERY_FAILED"), e.message ?: "query failed", "query")
            }
        }
    }

    // MARK: - beginTransaction

    @PluginMethod
    fun beginTransaction(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "beginTransaction")

        bridge.execute {
            try {
                impl.beginTransaction(database)
                success(call)
            } catch (e: Exception) {
                failure(call, errorCode(e, "TRANSACTION_FAILED"), e.message ?: "beginTransaction failed", "beginTransaction")
            }
        }
    }

    // MARK: - commitTransaction

    @PluginMethod
    fun commitTransaction(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "commitTransaction")

        bridge.execute {
            try {
                impl.commitTransaction(database)
                success(call)
            } catch (e: Exception) {
                failure(call, errorCode(e, "TRANSACTION_FAILED"), e.message ?: "commitTransaction failed", "commitTransaction")
            }
        }
    }

    // MARK: - rollbackTransaction

    @PluginMethod
    fun rollbackTransaction(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "rollbackTransaction")

        bridge.execute {
            try {
                impl.rollbackTransaction(database)
                success(call)
            } catch (e: Exception) {
                failure(call, errorCode(e, "TRANSACTION_FAILED"), e.message ?: "rollbackTransaction failed", "rollbackTransaction")
            }
        }
    }

    // MARK: - JSON bridge helpers

    private fun jsonArrayToValueList(arr: JSArray?, label: String): List<Any?> {
        arr ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val v = arr.get(i)
            unwrapJsonValue(v, "$label[$i]")
        }
    }

    private fun jsonArrayToStringList(arr: JSArray?, label: String): List<String> {
        arr ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val value = arr.get(i) as? String
                ?: throw IllegalArgumentException("'$label[$i]' must be a string")
            require(value.trim().isNotEmpty()) { "'$label[$i]' must be a non-empty string" }
            value
        }
    }

    private fun jsonArrayToListOfMaps(arr: JSArray?, label: String): List<Map<String, Any?>> {
        arr ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val obj = try {
                arr.getJSONObject(i)
            } catch (_: Exception) {
                throw IllegalArgumentException("'$label[$i]' must be an object")
            }
            val map = mutableMapOf<String, Any?>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val v = obj.get(key)
                map[key] = unwrapJsonValue(v, "$label[$i].$key")
            }
            map
        }
    }

    private fun unwrapJsonValue(v: Any, label: String): Any? = when (v) {
        JSONObject.NULL -> null
        is JSONArray    -> (0 until v.length()).map { i ->
            val item = v.get(i)
            unwrapJsonValue(item, "$label[$i]")
        }
        is JSONObject   -> throw IllegalArgumentException("'$label' must not be an object")
        else -> v
    }
}
