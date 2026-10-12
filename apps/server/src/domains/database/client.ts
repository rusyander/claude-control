import pg from 'pg';
import Cursor from 'pg-cursor';
import type { DbTarget } from './database.types.ts';
import { isLoopbackHost } from './sources/url.ts';

/**
 * Соединение только для чтения. Каждый запрос — своё соединение и своя
 * транзакция `READ ONLY` с таймаутом, затем ROLLBACK и закрытие: открытых
 * соединений панель не держит, и забытая вкладка не висит в `pg_stat_activity`.
 *
 * Значения приходят текстом, как их прислал Postgres: дата без перевода в часовой
 * пояс панели, `int8` без потери точности, JSON и байты как есть.
 */

export type DbErrorKind =
  'connect' | 'auth' | 'database-missing' | 'timeout' | 'read-only' | 'permission' | 'query';

export class DbError extends Error {
  readonly kind: DbErrorKind;
  /** Код SQLSTATE Postgres, если ответил сервер. */
  readonly sqlState?: string;
  /** Позиция ошибки в тексте запроса, с 1 — редактор подсветит место. */
  readonly position?: number;

  constructor(kind: DbErrorKind, message: string, sqlState?: string, position?: number) {
    super(message);
    this.kind = kind;
    if (sqlState) this.sqlState = sqlState;
    if (position) this.position = position;
  }
}

/** Все значения текстом: парсер типов — тождество. */
const RAW_TYPES = { getTypeParser: () => (value: string) => value };

const CONNECT_TIMEOUT_MS = 8_000;

/** Ошибка драйвера → вид, по которому окно скажет человеку, что делать. */
export function classifyError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const err = error as { code?: string; message?: string; position?: string };
  const message = err?.message ?? String(error);
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const position = err?.position ? Number(err.position) : undefined;
  if (code === '28P01' || code === '28000') return new DbError('auth', message, code);
  if (code === '3D000') return new DbError('database-missing', message, code);
  if (code === '57014') return new DbError('timeout', message, code);
  if (code === '25006') return new DbError('read-only', message, code, position);
  if (code === '42501') return new DbError('permission', message, code, position);
  if (code && /^[0-9A-Z]{5}$/.test(code)) return new DbError('query', message, code, position);
  // Сетевые: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, «Connection terminated due to connection timeout».
  return new DbError('connect', message, code);
}

export interface ReadOnlyOptions {
  /** Предел на запрос в базе (`statement_timeout`), он же — сторожевой таймер панели. */
  timeoutMs: number;
}

/** Postgres без TLS отвечает на запрос шифрования отказом — тогда повторяем без него. */
const noTlsOnServer = (error: unknown): boolean =>
  /does not support SSL|SSL is not enabled/i.test((error as Error)?.message ?? '');

async function connect(target: DbTarget, tls: boolean): Promise<pg.Client> {
  const client = new pg.Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    ...(target.password ? { password: target.password } : {}),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'agentdeck (read-only)',
    // К чужой машине — шифрование, к своей — без него. Сертификат проверяется
    // всегда: выключать проверку панель не умеет нигде (инвариант ca-fetch), и
    // база с самоподписанным сертификатом получает отказ словами, а не доверие.
    ...(tls ? { ssl: true } : {}),
    types: RAW_TYPES,
  });
  // Обрыв посреди работы приходит событием; без обработчика он роняет процесс.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/**
 * Выполнить `work` внутри `BEGIN READ ONLY` и всё закрыть. Сторожевой таймер
 * панели рвёт соединение, если сервер не уложился в свой же таймаут (сеть
 * повисла — `statement_timeout` тут не поможет).
 */
export async function withReadOnly<T>(
  target: DbTarget,
  options: ReadOnlyOptions,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  let client: pg.Client;
  const remote = !isLoopbackHost(target.host);
  try {
    client = await connect(target, remote);
  } catch (error) {
    if (!remote || !noTlsOnServer(error)) throw classifyError(error);
    try {
      client = await connect(target, false);
    } catch (retry) {
      throw classifyError(retry);
    }
  }

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    void client.end().catch(() => undefined);
  }, options.timeoutMs + 3_000);
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      `SET LOCAL statement_timeout = ${Math.max(1, Math.round(options.timeoutMs))}`,
    );
    await client.query("SET LOCAL lock_timeout = '3s'");
    return await work(client);
  } catch (error) {
    if (timedOut) throw new DbError('timeout', 'База не ответила вовремя — соединение закрыто.');
    throw classifyError(error);
  } finally {
    clearTimeout(watchdog);
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

export interface CursorResult {
  fields: { name: string; dataTypeID: number }[];
  rows: (string | null)[][];
  truncated: boolean;
}

/**
 * Прочитать не больше `limit` строк курсором. Курсор идёт расширенным
 * протоколом — второй оператор в одном тексте сервер не примет.
 */
export function readCursor(client: pg.Client, sql: string, limit: number): Promise<CursorResult> {
  const cursor = client.query(new Cursor(sql, [], { rowMode: 'array', types: RAW_TYPES }));
  return new Promise((resolve, reject) => {
    cursor.read(limit + 1, (error, rows, result) => {
      if (error) {
        reject(error);
        return;
      }
      const fields = (result?.fields ?? []).map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      }));
      const all = rows as unknown as (string | null)[][];
      cursor.close(() => {
        resolve({ fields, rows: all.slice(0, limit), truncated: all.length > limit });
      });
    });
  });
}

/** Имена типов по OID — одним запросом на все колонки результата. */
export async function typeNames(client: pg.Client, oids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(oids)].filter((oid) => oid > 0);
  if (unique.length === 0) return new Map();
  const result = await client.query<{ oid: string; typname: string }>(
    'SELECT oid::text AS oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
    [unique],
  );
  return new Map(result.rows.map((row) => [Number(row.oid), row.typname]));
}
