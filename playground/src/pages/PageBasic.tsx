import React, { useState } from 'react';
import { CapacitorSqlite } from '@devioarts/capacitor-sqlite';
import { Button } from '../components/Button.tsx';
import { Input, Label } from '../components/Input.tsx';
import { useLogger } from '../components/Logger.tsx';

const SCOPE = 'basic';

export const PageBasic: React.FC = () => {
  const log = useLogger();
  const [dbName, setDbName] = useState('myapp');
  const [readonly, setReadonly] = useState(false);

  const getPlatform = async () => {
    const r = await CapacitorSqlite.getPlatform();
    if (r.success) log.info(SCOPE, `getPlatform → ${r.data.platform}`, r.data);
    else log.error(SCOPE, 'getPlatform failed', r.error);
  };

  const isAvailable = async () => {
    const r = await CapacitorSqlite.isAvailable();
    if (r.success)
      log.info(SCOPE, `isAvailable → ${r.data.available}`, r.data);
    else log.error(SCOPE, 'isAvailable failed', r.error);
  };

  const open = async () => {
    const r = await CapacitorSqlite.open({ database: dbName, readonly });
    if (r.success) log.info(SCOPE, `open("${dbName}", readonly=${readonly}) → OK`);
    else log.error(SCOPE, `open("${dbName}") failed`, r.error);
  };

  const openInvalid = async () => {
    for (const name of ['../evil', 'test/db', 'test db', '']) {
      const r = await CapacitorSqlite.open({ database: name });
      if (!r.success)
        log.warn(SCOPE, `open("${name}") → [${r.error.code}] ${r.error.message}`);
      else log.error(SCOPE, `open("${name}") unexpectedly succeeded`);
    }
  };

  const isOpen = async () => {
    const r = await CapacitorSqlite.isOpen({ database: dbName });
    if (r.success) log.info(SCOPE, `isOpen("${dbName}") → ${r.data.open}`);
    else log.error(SCOPE, 'isOpen failed', r.error);
  };

  const close = async () => {
    const r = await CapacitorSqlite.close({ database: dbName });
    if (r.success) log.info(SCOPE, `close("${dbName}") → OK`);
    else log.error(SCOPE, `close("${dbName}") failed`, r.error);
  };

  const openTwiceDifferentMode = async () => {
    await CapacitorSqlite.close({ database: dbName }).catch(() => undefined);
    const r1 = await CapacitorSqlite.open({ database: dbName, readonly: false });
    log.info(SCOPE, `open("${dbName}", rw) → ${r1.success ? 'OK' : r1.error.code}`);
    const r2 = await CapacitorSqlite.open({ database: dbName, readonly: true });
    if (!r2.success && r2.error.code === 'DB_ALREADY_OPEN')
      log.info(SCOPE, `open("${dbName}", ro) → DB_ALREADY_OPEN ✓`);
    else log.error(SCOPE, `Expected DB_ALREADY_OPEN, got: ${r2.success ? 'success' : r2.error.code}`);
    await CapacitorSqlite.close({ database: dbName }).catch(() => undefined);
  };

  const openIdempotent = async () => {
    await CapacitorSqlite.close({ database: dbName }).catch(() => undefined);
    const r1 = await CapacitorSqlite.open({ database: dbName });
    const r2 = await CapacitorSqlite.open({ database: dbName });
    if (r1.success && r2.success)
      log.info(SCOPE, `open twice → both OK (idempotent) ✓`);
    else
      log.error(SCOPE, 'open idempotent test failed', { r1, r2 });
    await CapacitorSqlite.close({ database: dbName }).catch(() => undefined);
  };

  const closeNotOpen = async () => {
    const r = await CapacitorSqlite.close({ database: 'definitely_not_open_' + Date.now() });
    if (!r.success && r.error.code === 'DB_NOT_OPEN')
      log.info(SCOPE, `close(not open) → DB_NOT_OPEN ✓`);
    else log.error(SCOPE, 'Expected DB_NOT_OPEN', r);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Label label="Database name">
          <Input value={dbName} onChange={(e) => setDbName(e.target.value)} />
        </Label>
        <Label label="Readonly">
          <div className="flex items-center h-8">
            <input
              type="checkbox"
              className="h-4 w-4 accent-indigo-600"
              checked={readonly}
              onChange={(e) => setReadonly(e.target.checked)}
            />
            <span className="ml-2 text-sm text-slate-600">open as readonly</span>
          </div>
        </Label>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Platform</h3>
        <div className="flex flex-wrap gap-2">
          <Button onClick={getPlatform}>getPlatform()</Button>
          <Button onClick={isAvailable}>isAvailable()</Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Lifecycle</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="green" onClick={open}>open()</Button>
          <Button type="neutral" onClick={isOpen}>isOpen()</Button>
          <Button type="red" onClick={close}>close()</Button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">Edge cases</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="yellow" onClick={openInvalid}>Invalid names</Button>
          <Button type="yellow" onClick={openTwiceDifferentMode}>Open in different mode</Button>
          <Button type="yellow" onClick={openIdempotent}>Open twice (idempotent)</Button>
          <Button type="yellow" onClick={closeNotOpen}>Close not-open DB</Button>
        </div>
      </div>
    </div>
  );
};
