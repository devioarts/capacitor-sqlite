import XCTest
@testable import CapacitorSqlitePlugin

final class NativeBridgeValuesTests: XCTestCase {
    func testTaggedBlobDecodesWithoutChangingOrdinaryStrings() throws {
        let values = try NativeBridgeValues.decode([
            ["__capacitorSqliteBlobBase64": "AID/"],
            "__capacitorSqliteBlobBase64:literal",
            "blob64:literal"
        ], label: "values")
        XCTAssertEqual(values[0] as? Data, Data([0, 128, 255]))
        XCTAssertEqual(values[1] as? String, "__capacitorSqliteBlobBase64:literal")
        XCTAssertEqual(values[2] as? String, "blob64:literal")
    }

    func testEmptyTaggedBlobDecodes() throws {
        let values = try NativeBridgeValues.decode([
            ["__capacitorSqliteBlobBase64": ""]
        ], label: "values")
        XCTAssertEqual(values[0] as? Data, Data())
    }

    func testMalformedTaggedBlobIsRejected() {
        XCTAssertThrowsError(try NativeBridgeValues.decode([
            ["__capacitorSqliteBlobBase64": "%%%"]
        ], label: "values"))
        XCTAssertThrowsError(try NativeBridgeValues.decode([
            ["__capacitorSqliteBlobBase64": "AA==", "extra": true]
        ], label: "values"))
        XCTAssertThrowsError(try NativeBridgeValues.decode([
            ["other": "AA=="]
        ], label: "values"))
    }
}
