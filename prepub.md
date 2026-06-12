# Code Review: capacitor-sqlite — Cross-Platform Consistency

## Summary

Architektura je solidní a konzistentní v 95 % případů. Všechny 4 platformy (iOS, Android, Web, Electron) implementují stejných 15 metod se stejnými typy odpovědí. Níže jsou nálezy seřazené podle závažnosti.

---

## Kritické problémy

| # | Soubor | Místo | Problém | Závažnost |
|---|--------|-------|---------|-----------|
| 1 | `ios/Sources/CapacitorSqlitePlugin/CapacitorSqlitePlugin.swift:87` | `open()` | Migrace se **tiše zahodí** při chybném castování | 🔴 Kritické |
| 2 | `electron/src/index.ts:381` | `execute()` | `BEGIN` selže pokud je aktivní `beginTransaction()` | 🔴 Kritické |

### Issue 1 — iOS tichá chyba migrací

```swift
// iOS — tichý fallback na []
let migrations = call.getArray("migrations") as? [[String: Any]] ?? []
```

Pokud Capacitor bridge doručí array v jiném tvaru, migrace se tiše přeskočí. Android explicitně iteruje přes `jsonArrayToListOfMaps()` a vrací `MIGRATION_FAILED`. Oprava: validovat každý prvek stejně jako Android.

**Navrhovaná oprava:**

```swift
// v CapacitorSqlitePlugin.swift open()
guard let rawMigrations = call.getArray("migrations") else {
    // nil = žádné migrace v options, OK
    try self.impl.open(database: database, readonly: readonly, migrations: [])
    return
}
guard let migrations = rawMigrations as? [[String: Any]] else {
    self.failure(call, code: "MIGRATION_FAILED",
                 message: "'migrations' must be an array of objects", method: "open")
    return
}
```

### Issue 2 — `execute(transaction: true)` uvnitř `beginTransaction()`

Chování se liší platform od platformy:

| Platforma | Chování |
|-----------|---------|
| **Web** | ✅ Používá `SAVEPOINT` — bezpečně se vnořuje do aktivní transakce |
| **iOS** | ❌ Vrací `TRANSACTION_FAILED` ("a transaction is already active") |
| **Electron** | ❌ SQLite error "cannot start a transaction within a transaction" |
| **Android** | ⚠️ Android API transakce se tiše vnořují (různé chování) |

---

## Mírné problémy

| # | Soubor | Místo | Problém | Kategorie |
|---|--------|-------|---------|-----------|
| 3 | `android/.../Database.kt:159-163` | `rollbackTransaction()` | Android explicitně kontroluje `inTransaction`, iOS ne | Konzistence |
| 4 | `electron/src/index.ts:274` | `_doOpen()` | `enableForeignKeyConstraints: true` i pro readonly DB (Android/iOS jen pro `!readonly`) | Drobnost |
| 5 | `android/.../SQLiteHelpers.kt:29-31` | `run()` | Volání `lastInsertRowId()` i pro UPDATE/DELETE — vrací lastId z předchozího INSERT | Chování |

### Issue 3 — `rollbackTransaction()` bez aktivní transakce

```kotlin
// Android — vrací jasnou chybu
check(handle.inTransaction()) { "rollbackTransaction: no transaction is active on '$name'" }

// iOS — přímo pošle ROLLBACK do SQLite, chyba přijde ze SQLite
try SQLiteHelpers.rollbackTransaction(db: handle)
```

Na Androidu dostanete `TRANSACTION_FAILED` s jasnou zprávou. Na iOS dostanete SQLite error. Výsledek je stejný (správný error code), ale zprávy se liší.

---

## Co funguje dobře

- **Všech 15 metod** jsou implementovány konzistentně na všech 4 platformách (iOS, Android, Web, Electron)
- **Response shape** `{ success, data/error }` je identická napříč platformami — čitelný switch na JS straně
- **Migration locking** — správně serializováno na každé platformě (Android: ReentrantLock, iOS: DispatchQueue, Web: Promise coalescing)
- **`_doOpen()` coalescing** — souběžné volání `open()` pro stejnou DB se správně koaleskuje (Web + Electron)
- **Rollback on cleanup** — při selhání `open()` se DB správně zavírá na všech platformách
- **SAVEPOINT pattern ve Webu** — elegantnější než BEGIN/COMMIT pro `execute()`, umožňuje vnořování
- **Path traversal ochrana v Electronu** (`databasePath()`) — ověřuje, že výsledná cesta je uvnitř povolené složky
- **Electron `node:sqlite` lazy load** — selhání se správně propaguje jako `NOT_AVAILABLE`
- **Konzistentní error codes** — `SqliteErrorCode` union type přesně odpovídá tomu, co každá platforma vrací

---

## Verdict

**Request Changes** — Issue 1 (tiché zahazování migrací na iOS) je reálné riziko pro uživatele. Issue 2 (execute vs beginTransaction) je dokumentaci-worthy rozdíl nebo potřebuje sjednocení. Zbytek jsou drobnosti.
