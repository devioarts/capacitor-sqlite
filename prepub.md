# Code Review: capacitor-sqlite — Cross-Platform Consistency

> Poslední revize: 2026-06-13. Tento dokument byl aktualizován proti aktuálnímu kódu.
> Předchozí verze hlásila tři kritické problémy (tiché zahazování migrací na iOS,
> `execute()` uvnitř `beginTransaction()`, `lastInsertRowId` u UPDATE/DELETE) — **všechny
> tři jsou v aktuálním kódu opravené** a níže už nefigurují.

## Summary

Architektura je solidní a konzistentní. Všechny 4 platformy (iOS, Android, Web, Electron)
implementují stejných 15 metod se stejným tvarem odpovědi `{ success, data | error }`.
Validace vstupů, serializace přístupu k DB a cleanup při selhání `open()` jsou na dobré
úrovni. Zbývající nálezy jsou rozdíly v chování mezi platformami — žádný blokující bug,
ale před produkčním nasazením je vhodné je buď sjednotit, nebo zdokumentovat (většina už
zdokumentovaná je).

---

## Nálezy (žádný blokující)

| # | Soubor | Místo | Problém | Závažnost |
|---|--------|-------|---------|-----------|
| 1 | `android/.../SQLiteHelpers.kt:36-37` | `run()` | Víceřádkový INSERT (`VALUES (..),(..)` nebo `INSERT…SELECT`) hlásí `changes = 1` místo skutečného počtu | 🟠 Střední |
| 2 | `ios/.../SQLiteHelpers.swift:144-159` | `bindValue()` | Pořadí `case`ů — `Double` se testuje před `Int`/`Bool`, takže všechna čísla se bindují jako REAL | 🟡 Nízká–střední |
| 3 | `android/.../SQLiteHelpers.kt:52-66` | `query()` | BLOB (`Uint8Array`/`number[]`) parametry v `query()` nejsou na Androidu podporované (iOS/Web/Electron je podporují) | 🟡 Nízká (dokumentováno v kódu) |
| 4 | `execute()` napříč platformami | — | Každá položka `statements[]` musí být **jeden** SQL příkaz — víc příkazů v jednom stringu spolehlivě běží jen na iOS/Web, ne na Androidu/Electronu | 🟡 Nízká |
| 5 | `electron/src/index.ts:280` | `_doOpen()` | `enableForeignKeyConstraints: true` se nastavuje i pro readonly DB (iOS/Android jen pro `!readonly`) | ⚪ Drobnost |
| 6 | `ios/.../CapacitorSqlite.swift:200-208` | `requireOpen()` / `isOpen()` | `inst.isOpen` dělá `queue.sync` pod globálním `NSLock` → dlouhý dotaz na jedné DB blokuje operace nad ostatními DB | ⚪ Perf (jen multi-DB) |

### Issue 1 — Android: `changes` u víceřádkového INSERTu

```kotlin
// SQLiteHelpers.run()
if (isInsertLike(stmtType)) {
    val lastId = stmt.executeInsert()
    // executeInsert() vrací rowid posledního řádku, NE počet vložených řádků.
    return RunResult(changes = if (lastId >= 0L) 1L else 0L, ...)
}
```

`SQLiteStatement.executeInsert()` neumí vrátit počet zasažených řádků, takže `changes` je
napevno `1` pro každý úspěšný INSERT. Pro `INSERT INTO t VALUES (1),(2),(3)` nebo
`INSERT INTO t SELECT …` vrátí Android `changes = 1`, zatímco iOS/Web/Electron vrátí
skutečný počet. Týká se `run()`, `execute()` (přes `exec → run`) i `runBatch()`.
Běžný jednořádkový INSERT je v pořádku.

### Issue 2 — iOS: čísla se bindují jako REAL

V `bindValue` se `case let v as Double` vyhodnocuje dřív než `Int`/`Int64`/`Bool`. Protože
hodnoty z bridge přicházejí jako `NSNumber` a `NSNumber as? Double` vždy uspěje, **každé**
číslo i boolean se naváže jako `double`. Pro sloupce s afinitou INTEGER/NUMERIC to SQLite
převede zpět na integer (proto stávající testy procházejí), ale sloupce bez typu / s afinitou
BLOB hodnotu uloží jako REAL — `SELECT typeof(x)` pak na iOS vrátí `'real'`, na Androidu
`'integer'`. Doporučení: testovat proti netypovanému sloupci a případně přeřadit `case`y.

### Issue 6 — iOS: kontence globálního zámku

`requireOpen` drží `NSLock` po celou dobu volání `inst.isOpen`, které je `queue.sync`.
Dlouhý dotaz na DB-A tak blokuje `open/close/isOpen/requireOpen` i pro nesouvisející DB-B.
Android tuto vlastnost nemá (čte `isOpen` mimo globální `synchronized`). Pro aplikace s
jednou DB nehraje roli.

---

## Co funguje dobře

- **15 metod konzistentně** na všech 4 platformách; identický tvar odpovědi.
- **Migrace** — každá verze ve vlastní transakci, rollback při selhání, idempotentní `open()`.
- **Serializace** — iOS `DispatchQueue` per-DB, Android `ReentrantLock`, Web per-DB Promise fronta, Electron synchronní `node:sqlite`.
- **Coalescing souběžných `open()`** (Web + Electron) — sdílí jeden in-flight Promise.
- **Cleanup při selhání `open()`** — handle se zavře, instance se odebere z mapy (umožní retry).
- **Validace jmen DB** regexem `^[A-Za-z0-9_-]+$` + `:memory:` → ochrana proti path traversal.
- **Path traversal ochrana v Electronu** (`databasePath()`) — obrana do hloubky navíc.
- **`node:sqlite` lazy load** v Electronu — selhání se propaguje jako `NOT_AVAILABLE`.
- **`execute()`/`runBatch()` uvnitř `beginTransaction()`** vrací `TRANSACTION_FAILED` na všech platformách (sjednoceno).
- **`close()`** automaticky rollbackne otevřenou transakci.
- **Parametrizace** — hodnoty se vážou přes prepared statements, žádné string concat.

---

## Verdict

**Approve s výhradami** — žádný blokující bug. Před produkcí doporučuji: (a) sjednotit nebo
zdokumentovat Issue 1 (Android `changes`) a Issue 3/4 (BLOB v query, single-statement),
(b) empiricky ověřit round-trip `Uint8Array` přes Capacitor bridge na iOS/Androidu,
(c) zvážit přeřazení `case`ů v iOS bindu (Issue 2). Tyto body jsou popsané i v README.
