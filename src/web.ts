import { WebPlugin } from '@capacitor/core';

import type { CapacitorSqlitePlugin } from './definitions';

export class CapacitorSqliteWeb extends WebPlugin implements CapacitorSqlitePlugin {
  async echo(options: { value: string }): Promise<{ value: string }> {
    console.log('ECHO', options);
    return options;
  }
}
