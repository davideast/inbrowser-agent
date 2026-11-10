import { type SqliteDeps, createSqliteModule } from '../sqlite';

export type SqliteBuiltinDeps = SqliteDeps;

export function createSqliteBuiltin(deps: SqliteBuiltinDeps) {
  return createSqliteModule(deps);
}
