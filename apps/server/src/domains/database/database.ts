import type { DbUnsupported } from '@agentdeck/contracts';
import type { ComposeDbInput, DbTarget, ResolvedConnection } from './database.types.ts';
import { listManualConnections } from './manual.ts';
import { findConnections } from './sources/sources.ts';

export { checkReadOnlySql } from './sql-guard.ts';
export type { SqlRefusal } from './sql-guard.ts';
export { DbError } from './client.ts';
export type { DbErrorKind } from './client.ts';
export { runQuery, readSchema, SqlRefusedError, ROW_LIMIT, QUERY_TIMEOUT_MS } from './query.ts';
export { describeMigrations } from './migrations/migrations.ts';
export {
  ManualConnectionNotFoundError,
  removeManualConnection,
  saveManualConnection,
} from './manual.ts';
export type { ManualDraft } from './manual.ts';
export type { ComposeDbInput, ComposeDbService } from './database.types.ts';

/**
 * База данных проекта — фасад домена. Подключения находятся в файлах проекта
 * и в своих записях человека; запросы идут только транзакцией чтения.
 */

/** Все подключения проекта: найденные и свои. Паролей в ответе нет. */
export function listConnections(
  appData: string,
  root: string,
  compose: ComposeDbInput | undefined,
): { found: ResolvedConnection[]; unsupported: DbUnsupported[] } {
  const { connections, unsupported } = findConnections(
    root,
    compose,
    listManualConnections(appData, root),
  );
  return { found: connections, unsupported };
}

/** Реквизиты для соединения — с паролем, только для сервера. */
export function targetOf(connection: ResolvedConnection): DbTarget {
  const { host, port, database, user } = connection.info;
  return {
    host,
    port,
    database,
    user,
    ...(connection.password ? { password: connection.password } : {}),
  };
}
export {
  DATABASE_MCP_ID,
  DatabaseBridgeError,
  isDatabaseMcpRegistered,
  registerDatabaseMcp,
  unregisterDatabaseMcp,
} from './mcp-bridge.ts';
