import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Тестовая база OpenCode из записи НАСТОЯЩЕГО opencode 1.18.35
 * (`__fixtures__/opencode-1.18-session.json`): та же схема (DDL как в базе CLI) и
 * те же строки — сторож читает её тем же `node:sqlite`, что и живую базу.
 */

type Row = Record<string, string | number | null>;

interface Fixture {
  ddl: string[];
  rows: { session: Row[]; message: Row[]; part: Row[] };
}

interface WritableDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
  close(): void;
}
type WritableDriver = new (
  path: string,
  options?: { enableForeignKeyConstraints?: boolean },
) => WritableDb;

export const OPENCODE_FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__', 'opencode-1.18-session.json'), 'utf8'),
) as Fixture;

/** Корневая сессия записи и её субагент (`task`). */
export const ROOT_SESSION = 'ses_e8306ae24ffeJ1IivqBBaEP2r3';
export const CHILD_SESSION = 'ses_e83063a1affeb5eCGcUHI31NfE';

function driver(): WritableDriver {
  const mod = process.getBuiltinModule('node:sqlite') as { DatabaseSync: WritableDriver };
  return mod.DatabaseSync;
}

/** Строки одной транзакцией: построчная запись с fsync на Windows — секунды на тест. */
function insert(db: WritableDb, table: string, rows: readonly Row[]): void {
  db.exec('BEGIN');
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...columns.map((column) => row[column]));
  }
  db.exec('COMMIT');
}

/** База `file` со схемой и строками записи; `edit` правит строки до вставки. */
export function writeOpencodeDb(file: string, edit?: (rows: Fixture['rows']) => void): void {
  const rows = structuredClone(OPENCODE_FIXTURE.rows);
  edit?.(rows);
  // Таблицы `project` в записи нет: внешние ключи не проверяются, как и у снятой копии.
  const Driver = driver();
  const db = new Driver(file, { enableForeignKeyConstraints: false });
  try {
    for (const ddl of OPENCODE_FIXTURE.ddl) db.exec(ddl);
    insert(db, 'session', rows.session);
    insert(db, 'message', rows.message);
    insert(db, 'part', rows.part);
  } finally {
    db.close();
  }
}

/** Дописать строки в готовую базу — так, как пишет CLI посреди хода. */
export function appendOpencodeRows(
  file: string,
  rows: { message?: Row[]; part?: Row[]; session?: Row[] },
): void {
  const Driver = driver();
  const db = new Driver(file, { enableForeignKeyConstraints: false });
  try {
    insert(db, 'session', rows.session ?? []);
    insert(db, 'message', rows.message ?? []);
    insert(db, 'part', rows.part ?? []);
  } finally {
    db.close();
  }
}

/**
 * Писатель в режиме WAL, открытый, как у живого CLI: пока он открыт, записи лежат в
 * журнале `-wal`, а файл базы не меняется.
 */
export function openWalWriter(file: string): {
  append: (rows: { message?: Row[]; part?: Row[] }) => void;
  close: () => void;
} {
  const Driver = driver();
  const db = new Driver(file, { enableForeignKeyConstraints: false });
  db.exec('PRAGMA journal_mode=WAL');
  return {
    append: (rows) => {
      insert(db, 'message', rows.message ?? []);
      insert(db, 'part', rows.part ?? []);
    },
    close: () => db.close(),
  };
}

/**
 * Ответ модели с `n` вызовами оболочки, отбитыми человеком (текст отказа — из записи),
 * и его расходом: строки сообщения и частей в форме базы.
 */
export function deniedTurn(
  sessionId: string,
  at: number,
  n: number,
  tag: string,
): { message: Row[]; part: Row[] } {
  const messageId = `msg_${tag}`;
  const info = {
    role: 'assistant',
    modelID: 'stub-model',
    providerID: 'stub',
    tokens: { input: 300, output: 9, reasoning: 0, cache: { read: 1100, write: 0 } },
    time: { created: at, completed: at + 50 },
    finish: 'tool-calls',
  };
  const tool = (i: number): Row => ({
    id: `prt_${tag}_t${i}`,
    message_id: messageId,
    session_id: sessionId,
    time_created: at + 1 + i,
    time_updated: at + 2 + i,
    data: JSON.stringify({
      type: 'tool',
      callID: `call_${tag}_${i}`,
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: `git push try-${i}`, description: 'push' },
        error: 'The user rejected permission to use this specific tool call.',
        time: { start: at + 1 + i, end: at + 2 + i },
      },
    }),
  });
  return {
    message: [
      {
        id: messageId,
        session_id: sessionId,
        time_created: at,
        time_updated: at + 50,
        data: JSON.stringify(info),
      },
    ],
    part: [
      ...Array.from({ length: n }, (_, i) => tool(i)),
      {
        id: `prt_${tag}_f`,
        message_id: messageId,
        session_id: sessionId,
        time_created: at + 40,
        time_updated: at + 40,
        data: JSON.stringify({ type: 'step-finish', reason: 'tool-calls', tokens: info.tokens }),
      },
    ],
  };
}
