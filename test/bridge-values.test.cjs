const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  NATIVE_BLOB_BASE64_KEY,
  decodeElectronCompactRows,
  encodeNativeBridgeValue,
  encodeNativeBridgeValues,
  usesJsonValueBridge,
} = require('../build/test-p0/bridge-values.js');

function decodedEnvelope(value) {
  assert.equal(typeof value, 'object');
  assert.deepEqual(Object.keys(value), [NATIVE_BLOB_BASE64_KEY]);
  return Buffer.from(value[NATIVE_BLOB_BASE64_KEY], 'base64');
}

test('native bridge BLOB envelope preserves empty and full byte range values', () => {
  assert.deepEqual(decodedEnvelope(encodeNativeBridgeValue(new Uint8Array(), 'v')), Buffer.alloc(0));
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.deepEqual(decodedEnvelope(encodeNativeBridgeValue(bytes, 'v')), Buffer.from(bytes));
});

test('only Android and iOS use JSON value envelopes; Electron keeps Uint8Array', () => {
  assert.equal(usesJsonValueBridge('android'), true);
  assert.equal(usesJsonValueBridge('ios'), true);
  assert.equal(usesJsonValueBridge('electron'), false);
  assert.equal(usesJsonValueBridge('web'), false);
});

test('native bridge BLOB envelope preserves a 1 MB payload without number-array expansion', () => {
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, index) => (index * 31) & 0xff);
  const encoded = encodeNativeBridgeValue(bytes, 'v');
  assert.deepEqual(decodedEnvelope(encoded), Buffer.from(bytes));
  assert.equal(JSON.stringify(encoded).length < bytes.length * 1.4, true);
});

test('ordinary marker-looking strings remain ordinary strings', () => {
  const text = '__capacitorSqliteBlobBase64:not-a-blob';
  assert.equal(encodeNativeBridgeValue(text, 'v'), text);
  assert.equal(encodeNativeBridgeValue('blob64:literal text', 'v'), 'blob64:literal text');
});

test('valid runtime byte-array shorthand uses the same compact envelope', () => {
  assert.deepEqual(decodedEnvelope(encodeNativeBridgeValue([0, 128, 255], 'v')), Buffer.from([0, 128, 255]));
});

test('bridge value validation rejects malformed bytes and unsafe numbers before transport', () => {
  assert.throws(() => encodeNativeBridgeValue([0, 256], 'v'), /unsupported value type/);
  assert.throws(() => encodeNativeBridgeValue([0, 1.5], 'v'), /unsupported value type/);
  assert.throws(() => encodeNativeBridgeValue(Number.NaN, 'v'), /finite number/);
  assert.throws(() => encodeNativeBridgeValue(Number.MAX_SAFE_INTEGER + 1, 'v'), /MAX_SAFE_INTEGER/);
});

test('value lists retain scalar ordering while wrapping only BLOBs', () => {
  const encoded = encodeNativeBridgeValues(['a', 2, true, null, Uint8Array.from([3, 4])]);
  assert.deepEqual(encoded.slice(0, 4), ['a', 2, true, null]);
  assert.deepEqual(decodedEnvelope(encoded[4]), Buffer.from([3, 4]));
});

test('Electron compact rows reconstruct the documented object result shape', () => {
  assert.deepEqual(
    decodeElectronCompactRows({
      compactRows: {
        columns: ['id', 'v'],
        values: [
          [1, 'a'],
          [2, null],
        ],
      },
    }),
    [
      { id: 1, v: 'a' },
      { id: 2, v: null },
    ],
  );
});

test('Electron compact row decoder rejects malformed internal payloads', () => {
  assert.throws(() => decodeElectronCompactRows({}), /invalid compact query result/);
  assert.throws(
    () => decodeElectronCompactRows({ compactRows: { columns: ['id'], values: [[1, 2]] } }),
    /invalid compact row/,
  );
  assert.throws(
    () => decodeElectronCompactRows({ compactRows: { columns: [1], values: [[1]] } }),
    /invalid compact column names/,
  );
});
