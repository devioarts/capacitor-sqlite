import XCTest
@testable import CapacitorSqlitePlugin

class SQLStatementGuardTests: XCTestCase {

    func testAllowsSingleStatementWithTrailingSemicolonsAndComments() {
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1;"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1; ; -- done"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT ';' AS semi; /* done */"))
    }

    func testIgnoresSemicolonsInsideStringsIdentifiersAndComments() {
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 'a; b'"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT \"semi;name\" FROM t"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT [semi;name] FROM t"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1 /* ; */"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("SELECT 1 -- ;\n"))
    }

    func testRejectsMultipleStatementsAfterRealSemicolon() {
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("SELECT 1; SELECT 2"))
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE a(id); CREATE TABLE b(id)"))
    }

    func testLeadingBeginTransactionDoesNotMaskFollowingStatement() {
        // A leading BEGIN is a transaction statement, not a trigger-body opener.
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("BEGIN; DROP TABLE t"))
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("BEGIN TRANSACTION; DROP TABLE t; COMMIT"))
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("/* lead */ BEGIN; DROP TABLE t"))
        // Standalone transaction statements stay single.
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("BEGIN"))
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("BEGIN TRANSACTION;"))
        // Trigger bodies (BEGIN not at statement start) keep working.
        XCTAssertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE a SET x = 1; UPDATE b SET y = 2; END"
            )
        )
    }

    func testDoesNotMistakeBareBeginCaseIdentifierForTriggerBodyOpener() {
        // SQLite does not reserve BEGIN or CASE, so both are valid unquoted column/table
        // names. A naive "BEGIN/CASE anywhere but the first token opens a block" heuristic
        // would swallow the semicolon after these and hide the second statement.
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(begin TEXT); DROP TABLE users"))
        XCTAssertTrue(
            SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(begin TEXT, end TEXT); DROP TABLE users")
        )
        // Quoting still works as an explicit escape hatch.
        XCTAssertTrue(
            SQLiteHelpers.hasMultipleStatements("CREATE TABLE t(\"begin\" TEXT); DROP TABLE users")
        )
        // A qualified reference (NEW.begin in a trigger's WHEN clause) must not be mistaken
        // for the block-opening BEGIN either — the guard must still recognize the real one.
        XCTAssertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg AFTER UPDATE ON t WHEN NEW.begin IS NOT NULL " +
                "BEGIN INSERT INTO log VALUES (1); END"
            )
        )
        // Real trigger bodies and nested CASE expressions inside them keep working.
        XCTAssertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg_count AFTER INSERT ON items BEGIN UPDATE item_count SET n = n + 1; END"
            )
        )
        XCTAssertFalse(
            SQLiteHelpers.hasMultipleStatements(
                "CREATE TRIGGER trg_nested AFTER INSERT ON t BEGIN INSERT INTO log VALUES " +
                "(CASE WHEN NEW.a THEN (CASE WHEN NEW.b THEN 1 ELSE 2 END) ELSE 3 END); END"
            )
        )
    }

    func testDetectsUpsertConflictClauseSoRunAvoidsStaleLastInsertId() {
        XCTAssertTrue(SQLStatement.hasConflictClause("INSERT INTO t VALUES (1) ON CONFLICT(id) DO UPDATE SET v = 1"))
        XCTAssertTrue(SQLStatement.hasConflictClause("INSERT INTO t VALUES (1) ON CONFLICT(id) DO NOTHING"))
        XCTAssertFalse(SQLStatement.hasConflictClause("INSERT OR REPLACE INTO t VALUES (1)"))
        XCTAssertFalse(SQLStatement.hasConflictClause("INSERT OR IGNORE INTO t VALUES (1)"))
        XCTAssertFalse(SQLStatement.hasConflictClause("INSERT INTO t VALUES (1)"))
        XCTAssertFalse(SQLStatement.hasConflictClause("UPDATE t SET v = 1"))
        // The word must be a real keyword, not text inside a string/quoted identifier/comment.
        XCTAssertFalse(SQLStatement.hasConflictClause("INSERT INTO t (note) VALUES ('ON CONFLICT nice')"))
        XCTAssertFalse(SQLStatement.hasConflictClause("INSERT INTO t (\"conflict\") VALUES (1)"))
        XCTAssertFalse(SQLStatement.hasConflictClause("INSERT INTO t VALUES (1) /* on conflict */"))
    }

    func testQualifiedNewEndDoesNotCloseTriggerBodyEarly() {
        let trigger = "CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO log VALUES " +
            "(NEW.end); INSERT INTO log VALUES (2); END"
        XCTAssertFalse(SQLiteHelpers.hasMultipleStatements(trigger))
        XCTAssertTrue(SQLiteHelpers.hasMultipleStatements(trigger + "; SELECT 1"))
    }
    func testKeywordIdentifiersAndTriggerTerminatorsPreserveBoundaries() {
        let ordinary = [
            "SELECT begin FROM t",
            "SELECT end FROM t",
            "SELECT t . begin FROM t",
            "UPDATE t SET begin = 1",
            "DELETE FROM begin",
            "DROP TABLE begin",
            "CREATE TABLE begin(begin INTEGER, end INTEGER)",
            "SELECT CASE WHEN 1 THEN 2 ELSE 3 END"
        ]
        let triggers = [
            "CREATE TRIGGER begin AFTER INSERT ON t BEGIN SELECT 1; END",
            "CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN SELECT end FROM t; SELECT begin FROM t; END",
            "CREATE TEMPORARY TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; /* gap */ END",
            "CREATE TRIGGER tr AFTER UPDATE OF begin,end ON t WHEN NEW.begin > 0 BEGIN SELECT NEW.end; END",
            "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN NEW.begin THEN " +
                "CASE WHEN NEW.end THEN 1 ELSE 2 END ELSE 3 END; END",
            "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT '; END;', \"begin\", `end`, [case]; END",
            "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; -- END; hidden\nSELECT 2; END",
            "EXPLAIN CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END",
            "EXPLAIN QUERY PLAN CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END"
        ]
        for sql in ordinary {
            XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("/* lead */ \(sql); -- done"), sql)
            XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("\(sql); /* gap */ DELETE FROM t"), sql)
        }
        for sql in triggers {
            XCTAssertFalse(SQLiteHelpers.hasMultipleStatements("/* lead */ \(sql); /* done */"), sql)
            XCTAssertTrue(SQLiteHelpers.hasMultipleStatements("\(sql); /* gap */ DELETE FROM t"), sql)
        }
    }
}
