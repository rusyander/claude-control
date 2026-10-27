import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { opencodeDataDir } from '../../../../providers/catalog/config-dirs.ts';
import type { ForeignDocumentSource } from './foreign.types.ts';

/**
 * База сессий OpenCode (`<XDG_DATA_HOME | ~/.local/share>/opencode/opencode.db`,
 * SQLite) — только чтение. Переписку OpenCode 1.18 держит в базе, а не в файлах:
 * таблицы `session`, `message` и `part`, у записей сообщения и части — JSON в `data`.
 * Схема сверена с базой НАСТОЯЩЕГО opencode 1.18.35 (`__fixtures__/opencode-1.18-session.json`).
 *
 * Сессия в сторож идёт ссылкой `<база>#<id сессии>` на месте пути переписки: ссылка
 * одна и та же до и после смены ключа разговора на настоящий id — отданное не
 * читается снова.
 *
 * Драйвер — встроенный `node:sqlite`, берётся лениво: на Node без него (до 22.13 он
 * за флагом) сторож честно читает OpenCode только текстом хода.
 */

type Json = Record<string, unknown>;

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteDriver = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

let driver: SqliteDriver | null | undefined;

/** Драйвер SQLite процесса; нет — `undefined`. Предупреждение «experimental» не печатается. */
export function sqliteDriver(): SqliteDriver | undefined {
  if (driver !== undefined) return driver ?? undefined;
  const emit = process.emitWarning;
  // Единственный путь к модулю без предупреждения в журнал сервера на каждом старте.
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const mod = process.getBuiltinModule?.('node:sqlite') as
      { DatabaseSync?: SqliteDriver } | undefined;
    driver = mod?.DatabaseSync ?? null;
  } catch {
    driver = null;
  } finally {
    process.emitWarning = emit;
  }
  return driver ?? undefined;
}

/** Файл базы сессий OpenCode. */
export function opencodeDbFile(): string {
  return join(opencodeDataDir(), 'opencode.db');
}

/** Ссылка на сессию в базе. */
export function opencodeRef(db: string, sessionId: string): string {
  return `${db}#${sessionId}`;
}

/** База и id сессии из ссылки; не ссылка — `undefined`. */
export function parseOpencodeRef(ref: string): { db: string; sessionId: string } | undefined {
  const cut = ref.lastIndexOf('#');
  if (cut <= 0 || cut === ref.length - 1) return undefined;
  return { db: ref.slice(0, cut), sessionId: ref.slice(cut + 1) };
}

/** Запросы к базе одним открытием; база не открылась или запрос упал — `undefined`. */
function withDb<T>(db: string, read: (database: SqliteDatabase) => T): T | undefined {
  const Driver = sqliteDriver();
  if (!Driver) return undefined;
  let database: SqliteDatabase | undefined;
  try {
    database = new Driver(db, { readOnly: true });
    return read(database);
  } catch {
    return undefined;
  } finally {
    try {
      database?.close();
    } catch {
      /* уже закрыта */
    }
  }
}

function rows(database: SqliteDatabase, sql: string, ...params: unknown[]): Json[] {
  return database.prepare(sql).all(...params) as Json[];
}

/** Путь для сравнения: косые одинаково, без хвостовой косой, на Windows без учёта регистра. */
function pathKey(path: string, platform: NodeJS.Platform): string {
  const flat = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? flat.toLowerCase() : flat;
}

function realOf(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * Сессия первого хода: id сессии CLI панели ещё не известен. Это свежая корневая
 * сессия (не субагент) каталога копии, начатая не раньше `since`; каталог база
 * хранит прямыми косыми (`C:/…`), короткое имя 8.3 копии разворачивается.
 */
export function newestOpencodeSession(
  db: string,
  cwd: string,
  since: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!statOf(db)) return undefined;
  const wanted = new Set(
    [cwd, realOf(cwd)].flatMap((path) => (path ? [pathKey(path, platform)] : [])),
  );
  const found = withDb(db, (database) =>
    rows(
      database,
      'SELECT id, directory FROM session WHERE parent_id IS NULL AND time_created >= ? ORDER BY time_created DESC',
      since,
    ).find(
      (row) => typeof row.directory === 'string' && wanted.has(pathKey(row.directory, platform)),
    ),
  );
  return typeof found?.id === 'string' ? opencodeRef(db, found.id) : undefined;
}

/** Ссылка на сессию по её id; базы нет — `undefined`. Есть ли сессия, скажет чтение. */
export function opencodeSessionRef(db: string, sessionId: string): string | undefined {
  return statOf(db) ? opencodeRef(db, sessionId) : undefined;
}

function statOf(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const { mtimeMs, size } = statSync(path);
    return { mtimeMs, size };
  } catch {
    return undefined;
  }
}

function parsed(text: unknown): Json | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Json)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Глубина субагентов: субагент субагента — да, бесконечная цепочка битой базы — нет. */
const CHILD_DEPTH = 3;

function sessionDoc(
  database: SqliteDatabase,
  id: string,
  created: unknown,
  parentId: unknown,
  depth: number,
): Json {
  const parts = new Map<string, Json[]>();
  for (const row of rows(
    database,
    'SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id',
    id,
  )) {
    const data = parsed(row.data);
    if (!data || typeof row.message_id !== 'string') continue;
    const list = parts.get(row.message_id) ?? [];
    list.push({ ...data, id: row.id, created: row.time_created, updated: row.time_updated });
    parts.set(row.message_id, list);
  }
  const messages = rows(
    database,
    'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id',
    id,
  ).flatMap((row) => {
    const info = parsed(row.data);
    return info && typeof row.id === 'string'
      ? [{ id: row.id, created: row.time_created, info, parts: parts.get(row.id) ?? [] }]
      : [];
  });
  const children =
    depth < CHILD_DEPTH
      ? rows(
          database,
          'SELECT id, parent_id, time_created FROM session WHERE parent_id = ? ORDER BY time_created, id',
          id,
        ).flatMap((child) =>
          typeof child.id === 'string'
            ? [sessionDoc(database, child.id, child.time_created, child.parent_id, depth + 1)]
            : [],
        )
      : [];
  return { session: { id, parentId: parentId ?? null, created }, messages, children };
}

/**
 * Сессия целиком: `{session, messages: [{id, created, info, parts}], children}`;
 * у части — её JSON и `id`, `created`, `updated` записи. Субагенты (`task`) — дочерние
 * сессии. Сессии нет или база не читается — `undefined`.
 */
export function loadOpencodeSession(ref: string): unknown {
  const parsedRef = parseOpencodeRef(ref);
  if (!parsedRef) return undefined;
  return withDb(parsedRef.db, (database) => {
    const head = rows(
      database,
      'SELECT id, parent_id, time_created FROM session WHERE id = ?',
      parsedRef.sessionId,
    )[0];
    return head
      ? sessionDoc(database, parsedRef.sessionId, head.time_created, head.parent_id, 0)
      : undefined;
  });
}

/** Когда сессия родилась (`time_created`); нет — `undefined`. */
function opencodeBornAt(ref: string): number | undefined {
  const parsedRef = parseOpencodeRef(ref);
  if (!parsedRef) return undefined;
  const created = withDb(
    parsedRef.db,
    (database) =>
      rows(database, 'SELECT time_created FROM session WHERE id = ?', parsedRef.sessionId)[0]
        ?.time_created,
  );
  return typeof created === 'number' && Number.isFinite(created) ? created : undefined;
}

/**
 * Отпечаток базы: файл и его журнал WAL вместе. Запись любой сессии сдвигает его —
 * документ перечитывается не чаще раза в интервал сторожа, лишнее отсеет читатель.
 */
function opencodeStamp(ref: string): { mtimeMs: number; size: number } | undefined {
  const parsedRef = parseOpencodeRef(ref);
  const db = parsedRef ? statOf(parsedRef.db) : undefined;
  if (!parsedRef || !db) return undefined;
  const wal = statOf(`${parsedRef.db}-wal`);
  return wal ? { mtimeMs: Math.max(db.mtimeMs, wal.mtimeMs), size: db.size + wal.size } : db;
}

/** Источник документов OpenCode для сторожа. */
export const opencodeDocumentSource: ForeignDocumentSource = {
  stamp: opencodeStamp,
  bornAt: opencodeBornAt,
  load: loadOpencodeSession,
};
