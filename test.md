# Test Suite Coverage — @devioarts/capacitor-sqlite

**341 testů** v 70 skupinách pokrývajících iOS, Android, Web (WASM) a Electron.

Testy běží v záložce **Test Suite** v playground (`playground/src/tabs/SuiteTab.tsx`).
Zátěžové benchmarky (propustnost/latence) jsou v záložce **Load Tests** (`playground/src/tabs/StressTab.tsx`).

---

## Platform (2 testy)

| ID | Situace |
|----|---------|
| plat-01 | `getPlatform()` vrátí jednu ze známých hodnot (ios / android / web / electron) |
| plat-02 | `isAvailable()` vrátí `available = true` |

## Lifecycle (8 testů)

| ID | Situace |
|----|---------|
| lc-01 | `open` → `isOpen` → `close` — základní životní cyklus |
| lc-02 | `open` je idempotentní (dvojité otevření stejné DB nevadí) |
| lc-03 | Otevření DB v jiném režimu (rw → ro) → `DB_ALREADY_OPEN` |
| lc-04 | `close` na neotevřené DB → `DB_NOT_OPEN` |
| lc-05 | Neplatný název DB → `INVALID_NAME` |
| lc-06 | Data přežijí `close` + znovu `open` (perzistence) |
| lc-07 | `isOpen` na DB, která nebyla nikdy otevřena → `false` |
| lc-08 | 5 cyklů open/close za sebou — data zůstávají konzistentní |

## Execute (6 testů)

| ID | Situace |
|----|---------|
| ex-01 | `execute()` pro DDL + DML příkazy |
| ex-02 | `execute()` s prázdným polem příkazů → `INVALID_PARAMS` |
| ex-03 | `execute()` rollback při chybném SQL (transaction=true) |
| ex-04 | `execute(transaction:false)` — první příkaz zůstane committed i po selhání dalšího |
| ex-05 | `execute()` na uzavřené DB → `DB_NOT_OPEN` |
| ex-06 | `execute(transaction:true)` uvnitř `beginTransaction` → `TRANSACTION_FAILED` |

## Run (11 testů)

| ID | Situace |
|----|---------|
| run-01 | INSERT → `lastInsertId`, UPDATE → `changes` |
| run-02 | `run()` s hodnotou `null` |
| run-03 | `run()` s bool hodnotami (`true`/`false`) |
| run-04 | DELETE bez shody → `changes = 0` |
| run-05 | `typeof()` — integer uložen jako INTEGER, float jako REAL |
| run-06 | `REPLACE INTO` — aktualizace existujícího řádku, `lastInsertId` se mění |
| run-07 | `INSERT OR IGNORE` — UNIQUE konflikt → `changes = 0` |
| run-08 | `run()` se SELECT — uspěje, `lastInsertId = 0` |
| run-09 | `run()` na uzavřené DB → `DB_NOT_OPEN` |
| run-10 | Multi-row INSERT VALUES (a),(b),(c) — všechna data uložena |
| run-11 | UPSERT (`INSERT … ON CONFLICT DO UPDATE`) — SQLite 3.24+ (graceful skip na starším) |

## Query (15 testů)

| ID | Situace |
|----|---------|
| q-01 | `query()` na prázdné tabulce → prázdný výsledek |
| q-02 | `query()` s parametrizovaným WHERE |
| q-03 | `query()` vrátí správné typy (INTEGER, REAL, TEXT, NULL) |
| q-04 | `query()` na uzavřené DB → chyba |
| q-05 | Multi-sloupec: INTEGER, REAL, TEXT, NULL round-trip v jednom řádku |
| q-06 | LIMIT a OFFSET (stránkování) |
| q-07 | CTE (`WITH … AS`) query |
| q-08 | Agregační funkce COUNT, SUM, MIN, MAX, AVG |
| q-09 | INNER JOIN dvou tabulek |
| q-10 | GROUP BY + HAVING |
| q-11 | LIKE operátor s `%` a `_` wildcards |
| q-12 | `IN (…)` operátor s bound hodnotami |
| q-13 | ORDER BY více sloupců ASC/DESC |
| q-14 | LEFT JOIN — řádky bez shody jako NULL |
| q-15 | Korelovaný subquery v WHERE |

## RunBatch (5 testů)

| ID | Situace |
|----|---------|
| rb-01 | `runBatch()` vloží N řádků |
| rb-02 | `runBatch()` rollback při chybě (transaction=true) |
| rb-03 | `transaction:false` — úspěšné řádky committed i před chybou |
| rb-04 | `runBatch()` s prázdným polem → `INVALID_PARAMS` |
| rb-05 | `runBatch()` na uzavřené DB → `DB_NOT_OPEN` |

## Transactions (8 testů)

| ID | Situace |
|----|---------|
| tx-01 | `begin` → `run` → `commit` |
| tx-02 | `begin` → `run` → `rollback` |
| tx-03 | `beginTransaction` dvakrát → `TRANSACTION_FAILED` |
| tx-04 | `commitTransaction` bez begin → chyba |
| tx-05 | `rollbackTransaction` bez begin → chyba |
| tx-06 | `close()` automaticky rollbackuje necommitnutou transakci |
| tx-07 | `execute(transaction:false)` uvnitř manuální transakce — funguje |
| tx-08 | Necommitnuté zápisy jsou viditelné ve stejné transakci |

## Migrations (9 testů)

| ID | Situace |
|----|---------|
| mig-01 | Aplikace migrace v1 |
| mig-02 | Postupná migrace v1 → v2 |
| mig-03 | Idempotentní znovu-otevření se stejnými migracemi |
| mig-04 | Chybné SQL v migraci → `MIGRATION_FAILED` |
| mig-05 | Skok ve verzi (v1 → v3, přeskočení v2) |
| mig-06 | Migrace s více příkazy na verzi |
| mig-07 | Znovu-otevření s prázdným polem migrací — verze beze změny |
| mig-08 | Migrace aplikovány ve vzestupném pořadí bez ohledu na pořadí v poli |
| mig-09 | Selhání migrace v2 — DB zůstane na v1, znovu otevíratelná |

## Metadata (4 testy)

| ID | Situace |
|----|---------|
| gv-01 | `getVersion()` vrátí semver-like string |
| gv-02 | `getVersion()` na uzavřené DB → chyba |
| gv-03 | `vacuum()` na otevřené DB → úspěch |
| gv-04 | `getSchemaVersion()` na nové DB → 0 |

## BLOB (8 testů)

| ID | Situace |
|----|---------|
| blob-01 | `Uint8Array` round-trip |
| blob-02 | `null` BLOB uložen jako SQL NULL |
| blob-03 | Prázdný `Uint8Array` (0 bytů) round-trip |
| blob-04 | BLOB jako parametr WHERE v dotazu |
| blob-05 | Plný rozsah bytů 0x00–0xFF round-trip |
| blob-06 | Více BLOB sloupců v jednom řádku |
| blob-07 | UPDATE existující BLOB hodnoty |
| blob-08 | 50 KB BLOB round-trip — správnost dat |

## Multi-DB (5 testů)

| ID | Situace |
|----|---------|
| mdb-01 | Dvě DB otevřeny současně — žádná křížová kontaminace |
| mdb-02 | `:memory:` DB není perzistována po `close`/`reopen` (přeskočeno na Android — known limitation) |
| mdb-03 | Transakce na DB-A neovlivní DB-B |
| mdb-04 | `close(DB-A)` při otevřeném DB-B — B pokračuje normálně |
| mdb-05 | 3 DB otevřeny současně — všechny izolované |

## Readonly (5 testů)

| ID | Situace |
|----|---------|
| ro-01 | Readonly open — zápis → chyba (přeskočeno na Web — known limitation) |
| ro-02 | Readonly open — čtení → úspěch |
| ro-03 | Readonly + `execute()` → chyba (přeskočeno na Web) |
| ro-04 | Readonly + `vacuum()` → chyba (přeskočeno na Web) |
| ro-05 | Readonly + `getSchemaVersion()` → úspěch |

## Numeric (5 testů)

| ID | Situace |
|----|---------|
| num-01 | `MAX_SAFE_INTEGER` a `MIN_SAFE_INTEGER` round-trip |
| num-02 | Záporný float round-trip |
| num-03 | Integer `0` uložen jako INTEGER (ne NULL) |
| num-04 | SQL aritmetické funkce: ABS, ROUND, MAX scalar |
| num-05 | Float Pi uložen a načten s plnou přesností |

## String (6 testů)

| ID | Situace |
|----|---------|
| str-01 | Prázdný string je odlišný od NULL |
| str-02 | Unicode a emoji round-trip |
| str-03 | String s SQL metacharacters (`'`, `;`, `--`) |
| str-04 | Velmi dlouhý string (10 KB) round-trip |
| str-05 | String s vloženými `\n` a `\t` |
| str-06 | String se zpětným lomítkem a procentem |

## Schema (7 testů)

| ID | Situace |
|----|---------|
| sch-01 | CREATE INDEX — indexovaný sloupec dotazovatelný |
| sch-02 | `PRAGMA table_info` vrátí definice sloupců |
| sch-03 | `DROP TABLE IF EXISTS` na neexistující tabulce → úspěch |
| sch-04 | FOREIGN KEY constraint vynucen |
| sch-05 | CREATE VIEW + dotaz přes view |
| sch-06 | `ALTER TABLE ADD COLUMN` — existující řádky dostanou default |
| sch-07 | `sqlite_master` zobrazuje tabulky, indexy, views |

## Constraints (4 testy)

| ID | Situace |
|----|---------|
| con-01 | NOT NULL violation → `EXECUTE_FAILED` |
| con-02 | UNIQUE violation → `EXECUTE_FAILED` |
| con-03 | CHECK constraint violation → `EXECUTE_FAILED` |
| con-04 | PRIMARY KEY duplicate → `EXECUTE_FAILED` |

## Savepoints (2 testy)

| ID | Situace |
|----|---------|
| svp-01 | `SAVEPOINT` + `RELEASE` — obě změny commitnuty |
| svp-02 | `SAVEPOINT` + `ROLLBACK TO` — částečný rollback uvnitř transakce |

## DateTime (18 testů)

| ID | Situace |
|----|---------|
| dt-01 | ISO 8601 TEXT datum round-trip (`'2024-01-15T10:30:00.000Z'`) |
| dt-02 | Unix timestamp jako INTEGER uložen a načten |
| dt-03 | Juliánský den (REAL) uložen a načten |
| dt-04 | `date()` funkce vrátí `YYYY-MM-DD` |
| dt-05 | `datetime()` funkce vrátí `YYYY-MM-DD HH:MM:SS` |
| dt-06 | `strftime()` vlastní formát (`%d/%m/%Y`) |
| dt-07 | ISO datumy se řadí správně jako TEXT (lexikograficky = chronologicky) |
| dt-08 | Datová aritmetika — `+7 days`, `+1 month`, `-1 year` |
| dt-09 | `datetime('now')` vrátí neprázdný string ve správném formátu |
| dt-10 | Konverze Unix timestamp → datetime string (`unixepoch` modifier) |
| dt-11 | Konverze datetime string → Unix timestamp přes `strftime('%s',...)` |
| dt-12 | Uložení a načtení JS `new Date().toISOString()` |
| dt-13 | Date range dotaz s `BETWEEN` |
| dt-14 | Extrakce roku/měsíce/dne přes `strftime('%Y','%m','%d')` |
| dt-15 | `datetime(NULL)` vrátí NULL |
| dt-16 | `julianday()` konvertuje TEXT datum na Juliánský den |
| dt-17 | GROUP BY rok pomocí `strftime('%Y', d)` |
| dt-18 | Extrakce dne v týdnu `%w` (0=Ne, 1=Po, …) |

## SQL Functions (14 testů)

| ID | Situace |
|----|---------|
| fn-01 | `COALESCE(NULL, NULL, 'fallback')` → vrátí první non-NULL |
| fn-02 | `NULLIF(x, x)` → NULL; `NULLIF(x, y)` → x |
| fn-03 | `IFNULL(NULL, 'default')` → default |
| fn-04 | `CASE WHEN score >= 90 THEN 'A' … ELSE 'C' END` |
| fn-05 | `UPPER()` a `LOWER()` |
| fn-06 | `TRIM()`, `LTRIM()`, `RTRIM()` |
| fn-07 | `SUBSTR(str, start, length)` |
| fn-08 | `LENGTH(str)` a `INSTR(str, substr)` |
| fn-09 | `REPLACE(str, old, new)` — nahradí všechny výskyty |
| fn-10 | Konkatenace stringů operátorem `\|\|` |
| fn-11 | `ABS`, `ROUND`, `MIN`, `MAX` scalar funkce |
| fn-12 | `GLOB` pattern matching (`*` a `?` wildcards) |
| fn-13 | `LIKE` s `ESCAPE` znakem pro literální `%` a `_` |
| fn-14 | `TYPEOF()` vrátí SQLite typové názvy (integer/real/text/null) |

## NULL Handling (8 testů)

| ID | Situace |
|----|---------|
| null-01 | NULL aritmetika: `NULL + 1 = NULL`, `NULL * 100 = NULL` |
| null-02 | `NULL = NULL` je nepravdivé ve WHERE (nutno `IS NULL`) |
| null-03 | `IS NULL` a `IS NOT NULL` predikáty |
| null-04 | `COUNT(*)` zahrnuje NULLy; `COUNT(sloupec)` je vynechává |
| null-05 | Více NULL hodnot v UNIQUE sloupci povoleno (SQLite specifika) |
| null-06 | NULL se řadí před non-NULL hodnoty při ASC ORDER BY |
| null-07 | `NOT IN (1, 2, NULL)` nevrátí žádné řádky — SQL gotcha s NULL sémantikou |
| null-08 | `SUM`/`AVG`/`MIN`/`MAX` agregace přeskakují NULL hodnoty |

## Set Operations (4 testy)

| ID | Situace |
|----|---------|
| set-01 | `UNION` odstraní duplicitní řádky |
| set-02 | `UNION ALL` zachová všechny řádky včetně duplikátů |
| set-03 | `INTERSECT` vrátí řádky společné oběma výsledkům |
| set-04 | `EXCEPT` odstraní řádky, které jsou v druhém výsledku |

## EXISTS (2 testy)

| ID | Situace |
|----|---------|
| exists-01 | `EXISTS` subquery vrátí řádky když shoda nalezena |
| exists-02 | `NOT EXISTS` subquery vyloučí shodné řádky |

## Triggers (5 testů)

| ID | Situace |
|----|---------|
| trg-01 | `AFTER INSERT` trigger inkrementuje čítač v jiné tabulce |
| trg-02 | `BEFORE DELETE` trigger zapíše do audit logu (OLD.name) |
| trg-03 | `AFTER UPDATE` trigger zachytí OLD a NEW hodnoty |
| trg-04 | `DROP TRIGGER` — trigger přestane spouštět |
| trg-05 | `INSTEAD OF INSERT` trigger na VIEW (přesměruje do base tabulky) |

## Type Casting (8 testů)

| ID | Situace |
|----|---------|
| cast-01 | `CAST('42' AS INTEGER)` → integer |
| cast-02 | `CAST(123 AS TEXT)` → text |
| cast-03 | `CAST(3.9 AS INTEGER)` = 3, `CAST(-3.9 AS INTEGER)` = −3 (truncate toward zero) |
| cast-04 | Integer dělení: `7/2 = 3`; real dělení: `7.0/2 = 3.5` |
| cast-05 | Dělení nulou v SQLite vrátí NULL (ne chybu) |
| cast-06 | Velmi velké číslo blízko `Int64.max` uloženo přesně |
| cast-07 | TEXT afinita — integer uložen jako text |
| cast-08 | REAL afinita — integer uložen jako real |

## Recursive CTE (3 testy)

| ID | Situace |
|----|---------|
| rcte-01 | Rekurzivní CTE generuje sekvenci 1..10 |
| rcte-02 | Rekurzivní CTE počítá Fibonacciho čísla |
| rcte-03 | Rekurzivní CTE prochází stromovou hierarchii (parent-child) |

## Window Functions (3 testy — graceful skip na SQLite <3.25)

| ID | Situace |
|----|---------|
| wnd-01 | `ROW_NUMBER() OVER (ORDER BY)` přiřadí pořadová čísla |
| wnd-02 | `SUM() OVER (ORDER BY … ROWS UNBOUNDED PRECEDING)` — running total |
| wnd-03 | `RANK() OVER (ORDER BY)` — stejná hodnota dostane stejný rank, gap za ní |

## JSON Functions (3 testy — graceful skip na starém SQLite)

| ID | Situace |
|----|---------|
| json-01 | `json_extract(data, '$.name')` načte hodnotu z JSON sloupce |
| json-02 | `json('{"a":1}')` validuje a normalizuje JSON string |
| json-03 | `json_array(1, 'two', 3.0)` sestaví JSON pole z hodnot |

## Index Advanced (3 testy)

| ID | Situace |
|----|---------|
| idx-01 | UNIQUE INDEX odmítne duplicitní hodnoty |
| idx-02 | Kompozitní index na (a, b) — správná shoda na obou sloupcích |
| idx-03 | `DROP INDEX` — po odstranění duplicity opět povoleny |

## PRAGMA (6 testů)

| ID | Situace |
|----|---------|
| prg-01 | `PRAGMA integrity_check` → `ok` na zdravé DB |
| prg-02 | `PRAGMA foreign_keys = ON` — nastavení a čtení zpět |
| prg-03 | `PRAGMA table_info(t)` → metadata sloupců (name, type, notnull, pk) |
| prg-04 | `PRAGMA index_list(t)` → seznam indexů tabulky |
| prg-05 | `PRAGMA page_count` → kladné číslo |
| prg-06 | `PRAGMA cache_size = 500` — nastavení a čtení zpět |

## Foreign Keys (3 testy)

| ID | Situace |
|----|---------|
| fk-01 | FK constraint odmítne orphan řádek (PRAGMA foreign_keys = ON) |
| fk-02 | `ON DELETE CASCADE` — smazání rodiče smaže i potomky |
| fk-03 | `ON DELETE SET NULL` — smazání rodiče nulluje FK sloupec potomka |

## Advanced Queries (7 testů)

| ID | Situace |
|----|---------|
| adv-01 | Self-JOIN pro nalezení párů se stejnou hodnotou |
| adv-02 | CROSS JOIN — kartézský součin (2 barvy × 3 velikosti = 6 řádků) |
| adv-03 | LEFT JOIN — neodpovídající levé řádky zachovány jako NULL |
| adv-04 | Scalar subquery v SELECT listu (grand total ve každém řádku) |
| adv-05 | Korelovaný subquery ve WHERE (produkty nad průměrem své kategorie) |
| adv-06 | Více CTE v jednom dotazu |
| adv-07 | HAVING filtruje skupiny po agregaci |

## View (2 testy)

| ID | Situace |
|----|---------|
| view-01 | `CREATE VIEW` a dotaz přes view |
| view-02 | `DROP VIEW` — po odstranění dotaz na view selže |

## Error Handling (5 testů)

| ID | Situace |
|----|---------|
| err-01 | Dotaz na neexistující tabulku → `QUERY_FAILED` |
| err-02 | SQL syntax chyba v `execute()` → `EXECUTE_FAILED` |
| err-03 | NOT NULL porušení při INSERT → `EXECUTE_FAILED` |
| err-04 | CHECK constraint porušení → `EXECUTE_FAILED` |
| err-05 | INSERT do neexistující tabulky → `EXECUTE_FAILED` |

## Concurrency (5 testů)

| ID | Situace |
|----|---------|
| cc-01 | 10 paralelních `open()` na stejnou DB — vše uspěje nebo vrátí `DB_ALREADY_OPEN` |
| cc-02 | 10 paralelních `run()` INSERT — všechny řádky committed bez ztráty |
| cc-03 | 10 paralelních `query()` — všechny vrátí konzistentní data |
| cc-04 | Rychlé open→close→open 10 cyklů — data zůstávají stabilní |
| cc-05 | Paralelní `runBatch` + `query` — batch doběhne bez korupce |

## Invalid Params (8 testů)

| ID | Situace |
|----|---------|
| ip-01 | `run()` s prázdným SQL stringem → chyba |
| ip-02 | `query()` s prázdným SQL stringem → chyba |
| ip-03 | `execute()` s `''` v poli příkazů → chyba |
| ip-04 | `run()` s objektem `{}` jako parametrem — plugin nespadne |
| ip-05 | `run()` s `NaN` jako parametrem — JSON bridge převede na null (SQL NULL) |
| ip-06 | `run()` s `Infinity` jako parametrem — plugin nespadne |
| ip-07 | Název DB s path traversal `../` — odmítnut nebo sanitizován |
| ip-08 | Příliš dlouhý název DB (400 znaků) — chyba nebo ošetřeno |

## Error Format (4 testy)

| ID | Situace |
|----|---------|
| ef-01 | `run()` chyba má tvar `{ success:false, error:{ code, message } }` |
| ef-02 | `query()` chyba má konzistentní tvar `{ code, message }` |
| ef-03 | `execute()` chyba má konzistentní tvar |
| ef-04 | Všechny error kódy jsou `SCREAMING_SNAKE_CASE` stringy |

## Large Data (4 testy)

| ID | Situace |
|----|---------|
| ld-01 | 1 MB TEXT uložen a `LENGTH()` vrátí správnou délku |
| ld-02 | 1 MB BLOB (`Uint8Array`) uložen a `LENGTH()` vrátí správnou délku |
| ld-03 | Tabulka s 50 sloupci — všechny hodnoty uloženy a načteny správně |
| ld-04 | `IN` klauzule s 200 bound parametry — odpovídá 200 z 300 řádků |

## WAL Mode (4 testy)

| ID | Situace |
|----|---------|
| wal-01 | `PRAGMA journal_mode=WAL` — graceful skip na platformách bez podpory |
| wal-02 | `PRAGMA synchronous=NORMAL` — nastavení a čtení zpět jako 1 |
| wal-03 | `VACUUM` po hromadném DELETE — zkomprimuje a `integrity_check` projde |
| wal-04 | `ANALYZE` a `REINDEX` proběhnou úspěšně |

## Collation (5 testů)

| ID | Situace |
|----|---------|
| coll-01 | `COLLATE NOCASE` — case-insensitivní rovnost pro ASCII |
| coll-02 | `ORDER BY COLLATE NOCASE` řadí bez ohledu na velikost písmen |
| coll-03 | `LIKE` je case-insensitivní pro ASCII ve výchozím nastavení |
| coll-04 | Výchozí `BINARY` collation je case-sensitivní pro non-ASCII (SQLite limitace) |
| coll-05 | Unicode emoji uloženo a porovnáváno podle kódového bodu |

## Migration Extras (4 testy)

| ID | Situace |
|----|---------|
| me-01 | Migrace s verzí 0 není aplikována (`0 > current_version=0` je nepravdivé) |
| me-02 | `user_version` sleduje přesně každou verzi migrace |
| me-03 | Znovu-otevření s vyšší verzí — pouze nová migrace aplikována, stará data beze změny |
| me-04 | Selhání migrace ponechá `user_version` na poslední úspěšné verzi |

## Result Shape (5 testů)

| ID | Situace |
|----|---------|
| rs-01 | `query()` vždy vrátí pole řádků i když je prázdné |
| rs-02 | `run()` INSERT vždy vrátí `{ changes, lastInsertId }` |
| rs-03 | `run()` UPDATE bez shody → `changes=0, lastInsertId=0` |
| rs-04 | `runBatch()` vždy vrátí `{ changes, lastInsertId }` |
| rs-05 | Typy sloupců konzistentní: INTEGER→number, REAL→number, TEXT→string, NULL→null |

## Recovery (5 testů)

| ID | Situace |
|----|---------|
| rec-01 | DB použitelná po selhání `run()` — lze vložit a načíst data |
| rec-02 | DB použitelná po rollbacku transakce |
| rec-03 | DB použitelná po syntaktické chybě v `execute()` |
| rec-04 | DB použitelná po `query()` na neexistující tabulce |
| rec-05 | DB použitelná po 3 po sobě jdoucích různých chybách |

## Transaction Atomicity (5 testů)

| ID | Situace |
|----|---------|
| txn-01 | `begin` → `run`×3 + `runBatch` + `execute` → `rollback` — všech 6 insertů z 3 API metod vráceno |
| txn-02 | Uncommitted zápisy viditelné v rámci stejné transakce |
| txn-03 | `commit` persistuje zápisy z `run` + `execute` + `runBatch` — ověřeno po close/reopen |
| txn-04 | Rollback na DB-A neovlivní committed data na DB-B |
| txn-05 | Rollback po smíšených API (`run`+`execute`+`runBatch`) — nulový počet řádků |

## lastInsertId (5 testů)

| ID | Situace |
|----|---------|
| lid-01 | Tabulka bez `INTEGER PRIMARY KEY` — `lastInsertId` je implicitní rowid |
| lid-02 | Ručně nastavený `INTEGER PRIMARY KEY` — `lastInsertId` odpovídá zadanému id |
| lid-03 | `UPDATE` a `DELETE` vždy vrátí `lastInsertId = 0` |
| lid-04 | `AFTER INSERT` trigger — audit tabulka správně zaplněna |
| lid-05 | `AUTOINCREMENT` — id nejsou recyklována po smazání |

## WITHOUT ROWID (4 testy)

| ID | Situace |
|----|---------|
| wrid-01 | Základní INSERT / SELECT / DELETE na `WITHOUT ROWID` tabulce |
| wrid-02 | `WITHOUT ROWID` — duplikát primárního klíče → chyba |
| wrid-03 | UPDATE na `WITHOUT ROWID` tabulce |
| wrid-04 | `lastInsertId = 0` po INSERT do `WITHOUT ROWID` tabulky |

## FTS5 (3 testy — graceful skip pokud není k dispozici)

| ID | Situace |
|----|---------|
| fts-01 | `CREATE VIRTUAL TABLE USING fts5` + INSERT + `MATCH` vyhledávání |
| fts-02 | FTS5 `MATCH` vrátí pouze odpovídající řádky |
| fts-03 | FTS5 `DELETE` odebere dokument z indexu |

## Generated Columns (4 testy — graceful skip na SQLite <3.31)

| ID | Situace |
|----|---------|
| gen-01 | `VIRTUAL` generovaný sloupec vypočten při čtení |
| gen-02 | `STORED` generovaný sloupec vypočten při zápisu |
| gen-03 | INDEX nad generovaným sloupcem — dotaz vrátí správný řádek |
| gen-04 | INSERT do generovaného sloupce → chyba |

## STRICT Tables (3 testy — graceful skip na SQLite <3.37)

| ID | Situace |
|----|---------|
| strict-01 | `STRICT` tabulka přijme správné typy |
| strict-02 | INSERT špatného typu do `STRICT INTEGER` sloupce → chyba |
| strict-03 | `STRICT` tabulka s `ANY` sloupcem přijme integer, text i real |

## RETURNING (4 testy — graceful skip na SQLite <3.35)

| ID | Situace |
|----|---------|
| ret-01 | `INSERT ... RETURNING` vrátí vložený řádek přes `query()` |
| ret-02 | `UPDATE ... RETURNING` vrátí aktualizovanou hodnotu |
| ret-03 | `DELETE ... RETURNING` vrátí smazaný řádek |
| ret-04 | `INSERT ... RETURNING` s vypočteným výrazovým sloupcem |

## Parameter Limits (3 testy)

| ID | Situace |
|----|---------|
| param-01 | 999 bound parametrů v `SELECT IN()` — vše odpovídá |
| param-02 | 1001 parametrů → graceful výsledek (bez pádu) |
| param-03 | Jeden řádek s 256 KB TEXT sloupcem — délka správná |

## Semicolons & Comments (5 testů)

| ID | Situace |
|----|---------|
| mstmt-01 | Trailing středník v `run()` a `query()` — funguje |
| mstmt-02 | SQL s `--` inline komentářem — funguje |
| mstmt-03 | SQL s `/* blokový komentář */` — funguje |
| mstmt-04 | `execute()` se středníkem za každým příkazem |
| mstmt-05 | `run()` se dvěma příkazy oddělenými `;` — žádný pád |

## Identifier Quoting (4 testy)

| ID | Situace |
|----|---------|
| iq-01 | Tabulka pojmenovaná `"order"` (rezervované slovo) — double-quoted identifikátor |
| iq-02 | Sloupce `"select"` a `"group"` (rezervovaná slova) — double-quoted |
| iq-03 | Identifikátory s mezerami — double-quoted fungují |
| iq-04 | Unicode názvy tabulky a sloupců — double-quoted fungují |

## Boolean Policy (4 testy)

| ID | Situace |
|----|---------|
| bool-01 | `true` uložen jako `INTEGER 1`, `false` jako `INTEGER 0` |
| bool-02 | `TYPEOF(true)` = `integer` na všech platformách |
| bool-03 | Boolean round-trip: uložená hodnota se vrátí jako číslo, ne boolean |
| bool-04 | Více boolean parametrů v jednom řádku — konzistentní na všech platformách |

## Compatibility Matrix (1 test)

| ID | Situace |
|----|---------|
| compat-01 | Detekce dostupnosti: JSON, FTS5, Window funkce, RETURNING, STRICT, WAL, Generated cols |

## Real-world Schema (5 testů)

| ID | Situace |
|----|---------|
| rw-01 | Vytvoření 5-tabulkového e-commerce schématu (users, categories, products, orders, order_items) s FK, indexy, view |
| rw-02 | Seed realistickými daty — FK JOIN a filtr podle kategorie správně |
| rw-03 | Atomické vytvoření objednávky s položkami — celková cena správná přes aggregation view |
| rw-04 | `ON DELETE CASCADE` — smazání objednávky odstraní všechny `order_items` |
| rw-05 | Rollback na chybné objednávce — DB v čistém konzistentním stavu |

## Soak Tests (3 testy)

| ID | Situace |
|----|---------|
| soak-01 | 50× open → insert → query → close — data správná v každém cyklu |
| soak-02 | 30× open → selhávající query → close — plugin stabilní po 30 selháních |
| soak-03 | 20× insert 50 KB BLOB → read → delete — tabulka zůstane prázdná |

---

## Zátěžové benchmarky (StressTab)

10 benchmarků měřících propustnost (ops/s) a latenci (ms):

| # | Benchmark |
|---|-----------|
| 1 | Sekvenční `run()` — 500 INSERT operací |
| 2 | `runBatch()` — 500 řádků v jedné dávce |
| 3 | Manuální transakce — 500 INSERT operací |
| 4 | Souběžné zápisy — 20 paralelních `run()` |
| 5 | Smíšené čtení/zápis — 200 INSERT + 200 SELECT |
| 6 | Sken velké tabulky — 10 000 řádků, full scan |
| 7 | Filtrovaný dotaz — 10 000 řádků, WHERE + ORDER BY + LIMIT |
| 8 | Zápis velkého textu — 100× 50 KB TEXT |
| 9 | Zápis velkého BLOB — 100× 50 KB binárních dat |
| 10 | Souběžné multi-DB zápisy — 3 DB paralelně, 100 INSERT každá |

---

## Platformové speciality zachycené testy

| Situace | Platforma | Test |
|---------|-----------|------|
| Capacitor bridge kóduje JS integery jako Double-backed NSNumber | iOS | run-05 |
| `sqlite3_column_blob()` vrátí NULL pro zero-length BLOB | iOS | blob-03 |
| `:memory:` DB přežije `close()` díky connection poolu | Android | mdb-02 (skip) |
| `compileStatement` nepodporuje SELECT | Android | run-08 (skip) |
| `node:sqlite` ukládá všechna JS čísla jako REAL | Electron | run-05 |
| Web SQLite WASM nevynucuje readonly na zápis | Web | ro-01,03,04 (skip) |
| `NOT IN (… NULL)` nevrátí žádné řádky — SQL NULL sémantika | Všechny | null-07 |
| Dělení nulou v SQLite → NULL (ne chyba) | Všechny | cast-05 |
| Více NULL v UNIQUE sloupci je povoleno | Všechny | null-05 |
| Window funkce vyžadují SQLite ≥ 3.25 | Všechny | wnd-01..03 |
| `WITHOUT ROWID` INSERT → `lastInsertId = 0` (není rowid) | Všechny | wrid-04 |
| `true`/`false` uloženo jako INTEGER 1/0, vráceno jako `number` | Všechny | bool-01..04 |

## Query Plan (4 testy)

| ID | Situace |
|----|---------|
| plan-01 | `EXPLAIN QUERY PLAN` na neindexovaném sloupci obsahuje SCAN |
| plan-02 | `EXPLAIN QUERY PLAN` na indexovaném sloupci obsahuje SEARCH / INDEX |
| plan-03 | Pokrývající index (`covering index`) se projeví v query plánu |
| plan-04 | JOIN na indexovaném FK sloupci nezpůsobuje full scan na joinované tabulce |

## FK ON UPDATE (3 testy)

| ID | Situace |
|----|---------|
| fku-01 | `ON UPDATE CASCADE` — změna parent PK se propaguje do child FK |
| fku-02 | `ON UPDATE SET NULL` — změna parent PK nastaví child FK na NULL |
| fku-03 | `ON UPDATE RESTRICT` — změna parent PK je zablokována, dokud existují children |

## Deferred FK (3 testy)

| ID | Situace |
|----|---------|
| dfk-01 | `DEFERRABLE INITIALLY DEFERRED` — `commitTransaction` selže, pokud existuje FK porušení |
| dfk-02 | `DEFERRABLE INITIALLY DEFERRED` — v autocommit režimu je FK stále kontrolováno okamžitě |
| dfk-03 | `DEFERRABLE INITIALLY DEFERRED` — child před parentem v transakci → commit uspěje |

## Trigger Rollback (2 testy)

| ID | Situace |
|----|---------|
| trrb-01 | `BEFORE INSERT` trigger vyvolávající `RAISE(ABORT, …)` zabrání vložení řádku |
| trrb-02 | `AFTER INSERT` trigger vyvolávající `RAISE(ABORT, …)` vrátí vložení zpět |

## Conflict Policies (5 testů)

| ID | Situace |
|----|---------|
| conf-01 | `INSERT OR IGNORE` — duplicitní klíč je tiše přeskočen (`changes = 0`) |
| conf-02 | `INSERT OR REPLACE` — duplicitní klíč nahradí stávající řádek |
| conf-03 | `INSERT OR ABORT` — duplicita přeruší příkaz, ale transakce zůstane aktivní |
| conf-04 | `INSERT OR ROLLBACK` — duplicita automaticky odroluje celou aktivní transakci |
| conf-05 | `INSERT OR FAIL` — duplicita selže, stávající data zůstávají beze změny |

## Partial Indexes (3 testy)

| ID | Situace |
|----|---------|
| pidx-01 | `CREATE INDEX … WHERE` vytvoří partial index bez chyby |
| pidx-02 | Partial `UNIQUE INDEX` zabrání duplicitám uvnitř filtru |
| pidx-03 | Partial `UNIQUE INDEX` povolí duplicity mimo svůj filtr |

## Expression Indexes (2 testy)

| ID | Situace |
|----|---------|
| eidx-01 | `CREATE INDEX ON lower(col)` vytvoří expression index bez chyby |
| eidx-02 | `EXPLAIN QUERY PLAN` potvrdí použití expression indexu pro `lower(col)` predikát |

## Composite PK (3 testy)

| ID | Situace |
|----|---------|
| cpk-01 | Všechny unikátní kombinace složeného PK lze vložit |
| cpk-02 | Plně duplicitní kombinace složeného PK selže s chybou |
| cpk-03 | Sdílení jedné složky PK (různá druhá složka) je povoleno |

## Multi-column CHECK (2 testy)

| ID | Situace |
|----|---------|
| mchk-01 | Multi-sloupcový `CHECK (lo < hi)` propustí validní data |
| mchk-02 | Multi-sloupcový `CHECK (lo < hi)` odmítne nevalidní data |

## DEFAULT Values (4 testy)

| ID | Situace |
|----|---------|
| def-01 | `DEFAULT` textový literál je použit při vynechání sloupce v `INSERT` |
| def-02 | `DEFAULT (datetime('now'))` vygeneruje neprázdný timestamp |
| def-03 | `DEFAULT 0` (numerický) je použit při vynechání sloupce |
| def-04 | Explicitní `NULL` v `INSERT` přepíše `DEFAULT` hodnotu |

## Column Alter (2 testy)

| ID | Situace |
|----|---------|
| alter-01 | `ALTER TABLE RENAME COLUMN` (SQLite ≥ 3.25) — graceful skip na starší verzi |
| alter-02 | `ALTER TABLE DROP COLUMN` (SQLite ≥ 3.35) — graceful skip na starší verzi |

## Transaction State (2 testy)

| ID | Situace |
|----|---------|
| txstate-01 | Zanořené `beginTransaction` selže, pokud je jedna transakce již aktivní |
| txstate-02 | `commitTransaction` bez aktivní transakce selže s chybou |

## Column Names (3 testy)

| ID | Situace |
|----|---------|
| colname-01 | Sloupec s mezerou v názvu (double-quoted identifier) lze číst i zapisovat |
| colname-02 | Sloupec pojmenovaný podle SQL klíčového slova (`select`, `order`) funguje |
| colname-03 | Sloupec s Unicode znaky v názvu (`jméno`) funguje správně |

## Quote Semantics (2 testy)

| ID | Situace |
|----|---------|
| quote-01 | Jednoduché uvozovky = string literál; dvojité uvozovky = identifikátor |
| quote-02 | Backtick identifikátor (SQLite extension) funguje stejně jako double-quote |

---

## Scénáře, které nelze automatizovat

Tyto situace jsou mimo dosah JS testů a musejí být testovány ručně nebo jiným nástrojem:

| Kategorie | Proč nelze automatizovat |
|-----------|--------------------------|
| **Close během operace** (close() vs running query/batch/VACUUM) | Vyžaduje přesné časování na úrovni OS — v JS nelze garantovat race condition |
| **App lifecycle** (background→foreground, activity recreation, iOS suspend/resume) | Vyžaduje OS-level interakci s lifecyklem aplikace |
| **Storage failures** (disk full, quota exceeded, locked file, missing directory) | Vyžaduje manipulaci se souborovým systémem nebo OS prostředím |
| **Corrupted DB** (poškozený SQLite header, záměrně poškozený soubor) | Vyžaduje přímý přístup k nativnímu souboru — z JS vrstvy nedosažitelné |
| **Connection/memory leak measurement** (sledování file handles, RAM growth) | JS nemá přístup k OS file descriptors ani k heap profilerу native vrstvy |
| **Web/WASM persistence edge cases** (smazání IndexedDB, private/incognito, reload bez flush) | Vyžaduje manipulaci prohlížečem nad rámec JS testů |
| **Electron IPC security** (nepovolené kanály, absolutní cesty, ATTACH mimo adresář) | Vyžaduje platform-specific testování IPC vrstvy |
| **iOS NSURLIsExcludedFromBackupKey** | Native iOS atribut — není přístupný z JS |
| **SQLCipher šifrování** | Plugin šifrování nepodporuje |
| **App suspend/resume s otevřenou transakcí** | OS lifecycle, JS nemůže aplikaci minimalizovat |
| **Hot reload / JS context restart s native DB otevřenou** | Vyžaduje Capacitor live-reload infrastrukturu |
