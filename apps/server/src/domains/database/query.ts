import type { DbQueryMode, DbQueryResult, DbSchema, DbTable } from '@agentdeck/contracts';
import { readCursor, typeNames, withReadOnly } from './client.ts';
import type { DbTarget } from './database.types.ts';
import { checkReadOnlySql, type SqlRefusal } from './sql-guard.ts';

/** Строк в ответе не больше: окну хватит, агенту — тем более. */
export const ROW_LIMIT = 500;
/** Ячейка длиннее — обрезается: один JSON-документ на мегабайт не должен класть окно. */
const CELL_LIMIT = 10_000;
const PLAN_LINE_LIMIT = 5_000;
export const QUERY_TIMEOUT_MS = 15_000;
const SCHEMA_TABLE_LIMIT = 500;

export class SqlRefusedError extends Error {
  readonly refusal: SqlRefusal;

  constructor(refusal: SqlRefusal) {
    super(`refused: ${refusal.reason}`);
    this.refusal = refusal;
  }
}

const clipCell = (value: string | null): string | null =>
  value !== null && value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}…` : value;

/**
 * Выполнить запрос чтения. Сторож отказывает до соединения; режим «план с
 * выполнением» (`EXPLAIN ANALYZE`) запрос выполняет, но в той же транзакции
 * READ ONLY, так что записать он ничего не может.
 */
export async function runQuery(
  target: DbTarget,
  sql: string,
  mode: DbQueryMode = 'run',
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<DbQueryResult> {
  const verdict = checkReadOnlySql(sql);
  if (!verdict.ok) throw new SqlRefusedError(verdict);

  const explainPrefix =
    mode === 'run' || verdict.firstWord === 'explain'
      ? ''
      : mode === 'explain'
        ? 'EXPLAIN (FORMAT TEXT) '
        : 'EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ';
  const text = `${explainPrefix}${verdict.sql}`;
  const isPlan = explainPrefix !== '' || verdict.firstWord === 'explain';

  return withReadOnly(target, { timeoutMs }, async (client) => {
    const started = performance.now();
    const result = await readCursor(client, text, isPlan ? PLAN_LINE_LIMIT : ROW_LIMIT);
    const durationMs = Math.round(performance.now() - started);
    const names = await typeNames(
      client,
      result.fields.map((field) => field.dataTypeID),
    );
    const base: DbQueryResult = {
      mode,
      columns: result.fields.map((field) => ({
        name: field.name,
        type: names.get(field.dataTypeID) ?? String(field.dataTypeID),
      })),
      rows: result.rows.map((row) => row.map(clipCell)),
      truncated: result.truncated,
      durationMs,
    };
    if (!isPlan) return base;
    return { ...base, plan: result.rows.map((row) => row[0] ?? '').join('\n') };
  });
}

const SCHEMA_SQL = `
SELECT n.nspname AS schema,
       c.relname AS name,
       c.relkind AS kind,
       c.reltuples::bigint::text AS rows,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'name', a.attname,
                  'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
                  'nullable', NOT a.attnotnull,
                  'default', pg_catalog.pg_get_expr(d.adbin, d.adrelid)
                ) ORDER BY a.attnum)
           FROM pg_catalog.pg_attribute a
           LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       ), '[]')::text AS columns,
       COALESCE((
         SELECT json_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum))
           FROM pg_catalog.pg_index i
           JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = c.oid AND i.indisprimary
       ), '[]')::text AS pk
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
   AND NOT c.relispartition
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\\_toast%'
   AND n.nspname NOT LIKE 'pg\\_temp%'
 ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname
 LIMIT ${SCHEMA_TABLE_LIMIT + 1}`;

const KINDS: Record<string, DbTable['kind']> = {
  r: 'table',
  v: 'view',
  m: 'materialized-view',
  p: 'partitioned-table',
  f: 'foreign-table',
};

interface SchemaRow {
  schema: string;
  name: string;
  kind: string;
  rows: string;
  columns: string;
  pk: string;
}

/** Схема базы: таблицы и представления с колонками и первичным ключом. */
export async function readSchema(target: DbTarget, connectionId: string): Promise<DbSchema> {
  return withReadOnly(target, { timeoutMs: QUERY_TIMEOUT_MS }, async (client) => {
    const version = await client.query<{ server_version: string }>('SHOW server_version');
    const result = await client.query<SchemaRow>(SCHEMA_SQL);
    const tables = result.rows.slice(0, SCHEMA_TABLE_LIMIT).map((row): DbTable => {
      const columns = JSON.parse(row.columns) as {
        name: string;
        type: string;
        nullable: boolean;
        default: string | null;
      }[];
      return {
        schema: row.schema,
        name: row.name,
        kind: KINDS[row.kind] ?? 'table',
        rowsEstimate: Number(row.rows),
        columns: columns.map((column) => ({
          name: column.name,
          type: column.type,
          nullable: column.nullable,
          ...(column.default !== null ? { default: column.default } : {}),
        })),
        primaryKey: JSON.parse(row.pk) as string[],
      };
    });
    return {
      connectionId,
      serverVersion: version.rows[0]?.server_version ?? '',
      tables,
      truncated: result.rows.length > SCHEMA_TABLE_LIMIT,
    };
  });
}
