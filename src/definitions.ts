export interface CapacitorSqlitePlugin {
  echo(options: { value: string }): Promise<{ value: string }>;
}
