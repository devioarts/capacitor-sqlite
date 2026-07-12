package com.devioarts.capacitor.sqlite

import android.util.Base64
import java.nio.charset.StandardCharsets
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(name = "CapacitorSqlite")
class CapacitorSqlitePlugin : Plugin() {

    private companion object {
        const val NATIVE_BLOB_BASE64_KEY = "__capacitorSqliteBlobBase64"
    }

    private lateinit var impl: CapacitorSqlite
    private val sqliteExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "capacitor-sqlite")
    }

    override fun load() {
        impl = CapacitorSqlite(context)
    }

    override fun handleOnDestroy() {
        if (::impl.isInitialized) {
            // Enqueue on the SQLite thread instead of calling impl.closeAll() directly:
            // this runs after any already-queued operations finish (in order, same as
            // every other method call), and keeps the close()/WAL-checkpoint I/O off the
            // calling (bridge/UI) thread.
            try {
                sqliteExecutor.execute { impl.closeAll() }
            } catch (_: RejectedExecutionException) {
                // handleOnDestroy() called more than once — nothing left to flush.
            }
        }
        // shutdown() (not shutdownNow()) lets already-queued PluginCalls — including the
        // closeAll() task just submitted above — run to completion instead of being
        // silently dropped without ever resolving their JS Promise. Do not wait here:
        // Capacitor may call handleOnDestroy() on the UI thread, and a large queued batch
        // or WAL checkpoint must not freeze that thread for up to several seconds.
        sqliteExecutor.shutdown()
    }

    // MARK: - Unified response helpers

    private fun success(call: PluginCall, data: JSObject = JSObject()) {
        call.resolve(JSObject().put("success", true).put("data", data))
    }

    private fun failure(call: PluginCall, code: String, message: String, method: String) {
        val details = JSObject()
            .put("nativeCode", code)
            .put("nativeMessage", message)
            .put("source", "android-native")
        call.resolve(
            JSObject()
                .put("success", false)
                .put("error", JSObject()
                    .put("code", code)
                    .put("message", message)
                    .put("platform", "android")
                    .put("method", method)
                    .put("details", details)
                )
        )
    }

    private fun errorCode(e: Exception, fallback: String): String {
        return if (e is CapacitorSqliteException) e.code else fallback
    }

    private fun executeSqlite(block: () -> Unit) {
        sqliteExecutor.execute(block)
    }

    private fun timingsToJson(timings: Map<String, Double>): JSObject {
        val out = JSObject()
        timings.forEach { (key, value) -> out.put(key, value) }
        return out
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

        executeSqlite {
            try {
                impl.open(database, readonly, directory, migrations)
                success(call)
            } catch (e: Exception) {
                failure(call, errorCode(e, "OPEN_FAILED"), e.message ?: "open failed", "open")
            }
        }
    }

    // MARK: - close

    @PluginMethod
    fun close(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "close")

        executeSqlite {
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

        executeSqlite {
            try {
                success(call, JSObject().put("open", impl.isOpen(database)))
            } catch (e: Exception) {
                failure(call, errorCode(e, "UNKNOWN"), e.message ?: "isOpen failed", "isOpen")
            }
        }
    }

    // MARK: - getVersion

    @PluginMethod
    fun getVersion(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "getVersion")

        executeSqlite {
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

        executeSqlite {
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

        executeSqlite {
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

        executeSqlite {
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

        executeSqlite {
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
        val nativeStart = System.nanoTime()
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "runBatch")
        val getArrayStart = System.nanoTime()
        val rawSet = call.getArray("set")
        val getArrayMs = (System.nanoTime() - getArrayStart) / 1_000_000.0
        val decodeStart = System.nanoTime()
        val set = try {
            jsonArrayToListOfMaps(rawSet, "set")
        } catch (e: IllegalArgumentException) {
            return failure(call, "INVALID_PARAMS", e.message ?: "Invalid set", "runBatch")
        }
        val decodeMs = (System.nanoTime() - decodeStart) / 1_000_000.0
        if (set.isEmpty()) {
            return failure(call, "INVALID_PARAMS", "'set' must be a non-empty array", "runBatch")
        }
        val transaction = call.getBoolean("transaction", true) ?: true
        val includeDiagnostics = call.getBoolean("__diagnostics", false) ?: false
        val timings = if (includeDiagnostics) linkedMapOf<String, Double>() else null
        timings?.put("pluginGetArrayMs", getArrayMs)
        timings?.put("bridgeDecodeMs", decodeMs)

        val scheduledAt = System.nanoTime()
        executeSqlite {
            timings?.put("queueWaitMs", (System.nanoTime() - scheduledAt) / 1_000_000.0)
            try {
                val result = impl.runBatch(database, set, transaction, timings)
                timings?.put("nativeTotalMs", (System.nanoTime() - nativeStart) / 1_000_000.0)
                val data = JSObject().put("changes", result.changes).put("lastInsertId", result.lastInsertId)
                timings?.let { data.put("timings", timingsToJson(it)) }
                success(call, data)
            } catch (e: Exception) {
                failure(call, errorCode(e, "EXECUTE_FAILED"), e.message ?: "runBatch failed", "runBatch")
            }
        }
    }

    // MARK: - runMany

    @PluginMethod
    fun runMany(call: PluginCall) {
        val database = call.getString("database")
            ?: return failure(call, "INVALID_PARAMS", "'database' is required", "runMany")
        val statement = call.getString("statement")
            ?: return failure(call, "INVALID_PARAMS", "'statement' is required", "runMany")
        if (statement.trim().isEmpty()) {
            return failure(call, "INVALID_PARAMS", "'statement' is required", "runMany")
        }
        val valueSets = try {
            val decoded = jsonArrayToValueList(call.getArray("values"), "values")
            if (decoded.isEmpty()) throw IllegalArgumentException("'values' must be a non-empty array of value arrays")
            decoded.mapIndexed { index, value ->
                @Suppress("UNCHECKED_CAST")
                value as? List<Any?>
                    ?: throw IllegalArgumentException("'values[$index]' must be an array")
            }
        } catch (e: IllegalArgumentException) {
            return failure(call, "INVALID_PARAMS", e.message ?: "Invalid values", "runMany")
        }
        val transaction = call.getBoolean("transaction", true) ?: true
        val returnResults = call.getBoolean("returnResults", false) ?: false

        executeSqlite {
            try {
                val result = impl.runMany(database, statement, valueSets, transaction, returnResults)
                val data = JSObject().put("changes", result.changes).put("lastInsertId", 0)
                result.results?.let { items ->
                    val encoded = JSArray()
                    items.forEach { item ->
                        encoded.put(JSObject().put("changes", item.changes).put("lastInsertId", item.lastInsertId))
                    }
                    data.put("results", encoded)
                }
                success(call, data)
            } catch (e: Exception) {
                failure(call, errorCode(e, "EXECUTE_FAILED"), e.message ?: "runMany failed", "runMany")
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

        executeSqlite {
            try {
                if (call.getBoolean("__capacitorSqliteCompactRows", false) == true) {
                    val compact = impl.queryCompact(database, statement, values)
                    val encodedRows = JSArray()
                    compact.values.forEach { row ->
                        val encoded = JSArray()
                        row.forEach { value -> encoded.put(encodeQueryValue(value)) }
                        encodedRows.put(encoded)
                    }
                    success(
                        call,
                        JSObject().put(
                            "compactRows",
                            JSObject().put("columns", JSArray(compact.columns)).put("values", encodedRows)
                        )
                    )
                    return@executeSqlite
                }
                val rows = impl.query(database, statement, values)
                val result = JSArray()
                for (row in rows) {
                    val obj = JSObject()
                    for ((key, value) in row) {
                        obj.put(key, encodeQueryValue(value))
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

        executeSqlite {
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

        executeSqlite {
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

        executeSqlite {
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
        is JSONObject   -> decodeTaggedBlob(v, label)
        else -> v
    }

    /** Decode the compact internal BLOB envelope emitted by src/bridge-values.ts. */
    private fun decodeTaggedBlob(value: JSONObject, label: String): ByteArray {
        if (value.length() != 1 || !value.has(NATIVE_BLOB_BASE64_KEY)) {
            throw IllegalArgumentException("'$label' must not be an object")
        }
        val encoded = value.opt(NATIVE_BLOB_BASE64_KEY) as? String
            ?: throw IllegalArgumentException("'$label.$NATIVE_BLOB_BASE64_KEY' must be a base64 string")
        return try {
            Base64.decode(encoded, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            throw IllegalArgumentException("'$label.$NATIVE_BLOB_BASE64_KEY' must be valid base64")
        }
    }

    private fun encodeText(value: String): String {
        if (!value.startsWith(SQLiteHelpers.BLOB_PREFIX) && !value.startsWith(SQLiteHelpers.TEXT_PREFIX)) {
            return value
        }
        val encoded = Base64.encodeToString(value.toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP)
        return SQLiteHelpers.TEXT_PREFIX + encoded
    }

    private fun encodeQueryValue(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is ByteArray -> SQLiteHelpers.BLOB_PREFIX + Base64.encodeToString(value, Base64.NO_WRAP)
        is String -> encodeText(value)
        else -> value
    }
}
