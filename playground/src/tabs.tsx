import type { ReactNode } from 'react';
import { PageBasic } from './pages/PageBasic.tsx';
import { PageCrud } from './pages/PageCrud.tsx';
import { PageBatch } from './pages/PageBatch.tsx';
import { PageTransaction } from './pages/PageTransaction.tsx';
import { PageMigration } from './pages/PageMigration.tsx';
import { PageExtras } from './pages/PageExtras.tsx';
import { PageSuite } from './pages/PageSuite.tsx';
import { PageStress } from './pages/PageStress.tsx';

export type TabItem = {
  id: string;
  label: string;
  page: ReactNode;
};

export const tabs: TabItem[] = [
  { id: 'basic',      label: 'Basic',        page: <PageBasic /> },
  { id: 'crud',       label: 'CRUD',         page: <PageCrud /> },
  { id: 'batch',      label: 'Batch',        page: <PageBatch /> },
  { id: 'tx',         label: 'Transactions', page: <PageTransaction /> },
  { id: 'migrations', label: 'Migrations',   page: <PageMigration /> },
  { id: 'extras',     label: 'Extras',       page: <PageExtras /> },
  { id: 'suite',      label: 'Test Suite',   page: <PageSuite /> },
  { id: 'stress',     label: 'Load Tests',   page: <PageStress /> },
];
