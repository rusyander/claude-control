import { existsSync, mkdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, join } from 'node:path';
import { currentOs } from '../../platform/os-kind.ts';
import { roamingAppDataDir, xdgDataHome } from '../../platform/user-dirs.ts';
import type { SessionSpec } from '../adapter.types.ts';
import { ownedAnswer, resumeRefusal, resumeSourceOf, rootMatches } from '../resume-store.ts';
import type { ResumeStage, TranscriptVerdict } from '../resume-store.types.ts';

/**
 * Хранилище разговоров Goose (1.54, проба 02.11 на stub-model): база sqlite
 * `<данные>/sessions/sessions.db`, разговор — строка `sessions` (`id`, `working_dir`) и его строки
 * `messages` (+ `usage_ledger`). Id — `ГГГГММДД_<n>` по счётчику БАЗЫ: в разных домах он
 * повторяется, поэтому источник продолжения сессии ядра — каталог именно той сессии (`resume.from`).
 * `session/load` в свежем корне находит разговор по базе с одной этой сессией (проба), поэтому
 * продолжение строит в доме сеанса НОВУЮ базу той же схемы и переносит только строки разговора:
 * чужие разговоры человека в копию не попадают. Нет `node:sqlite` у Node — не прочитать.
 */

export const GOOSE_HOME_DIR = 'goose-home';
const GOOSE_SESSION_ID = /^\d{8}_\d{1,9}$/;
/** База под корнем `GOOSE_PATH_ROOT`: `<корень>/data/sessions/sessions.db` (проба). */
const ROOT_DB = join('data', 'sessions', 'sessions.db');
/** Таблицы разговора: строки переносятся по его id; прочее (каталог моделей) не копируется. */
const SESSION_ROWS: readonly { table: string; key: string }[] = [
  { table: 'sessions', key: 'id' },
  { table: 'messages', key: 'session_id' },
  { table: 'usage_ledger', key: 'session_id' },
];

type Sqlite = typeof import('node:sqlite');

/** `node:sqlite` есть с Node 22.5 (экспериментальный): нет — хранилище Goose не прочитать. */
function sqlite(): Sqlite | null {
  try {
    return (process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * База Goose человека по пину: `GOOSE_PATH_ROOT`, иначе каталог данных ОС (Windows
 * `%APPDATA%\Block\goose\data`, иначе `$XDG_DATA_HOME|~/.local/share` + `goose`). Относительный
 * корень Goose достроил бы от своего cwd — ядро не угадывает.
 */
export function gooseHumanDb(pin: Record<string, string>): string | null {
  const root = pin.GOOSE_PATH_ROOT;
  if (root) return isAbsolute(root) ? join(root, ROOT_DB) : null;
  if (currentOs() === 'win32') {
    return join(roamingAppDataDir(pin), 'Block', 'goose', 'data', 'sessions', 'sessions.db');
  }
  return join(xdgDataHome(pin), 'goose', 'sessions', 'sessions.db');
}

/** База Goose дома сеанса ядра (`<сеанс>/goose-home`). */
export const gooseSessionDb = (sessionDir: string): string =>
  join(sessionDir, GOOSE_HOME_DIR, ROOT_DB);

/** Разговор `id` в базе `db`: свой — строка `sessions` с этим id и папкой `root`. */
export function findGooseSession(db: string, root: string | null, id: string): TranscriptVerdict {
  if (!GOOSE_SESSION_ID.test(id)) return 'absent';
  if (!existsSync(db)) return 'absent';
  const lib = sqlite();
  if (!lib) return 'unreadable';
  let conn: DatabaseSync | null = null;
  try {
    conn = new lib.DatabaseSync(db, { readOnly: true });
    const row = conn.prepare('SELECT working_dir FROM sessions WHERE id = ?').get(id) as
      { working_dir?: unknown } | undefined;
    if (!row) return 'absent';
    return rootMatches(row.working_dir, root) ? 'owned' : 'foreign';
  } catch {
    return 'unreadable';
  } finally {
    conn?.close();
  }
}

/** Новая база той же схемы с одним разговором `id` (строки по таблицам `SESSION_ROWS`). */
export function copyGooseSession(source: string, target: string, id: string): void {
  const lib = sqlite();
  if (!lib) throw new Error('node:sqlite is not available');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const src = new lib.DatabaseSync(source, { readOnly: true });
  const dst = new lib.DatabaseSync(target);
  try {
    const schema = src
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
      )
      .all() as { name: string; sql: string }[];
    const tables = new Set(schema.map((s) => s.name));
    dst.exec('BEGIN');
    for (const { sql } of schema) dst.exec(sql);
    const copy = (table: string, where: string, args: string[]): void => {
      const rows = src.prepare(`SELECT * FROM "${table}" ${where}`).all(...args);
      for (const row of rows) {
        const cols = Object.keys(row);
        const insert = dst.prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        insert.run(...(cols.map((c) => row[c]) as never[]));
      }
    };
    // Версия схемы — иначе Goose сочтёт базу пустой и начнёт миграции заново.
    if (tables.has('schema_version')) copy('schema_version', '', []);
    for (const { table, key } of SESSION_ROWS) {
      if (tables.has(table)) copy(table, `WHERE "${key}" = ? ORDER BY rowid`, [id]);
    }
    dst.exec('COMMIT');
  } finally {
    src.close();
    dst.close();
  }
}

/** Разговор Goose, начатый не ядром, — этого корня (этап 10; `CliAdapter.ownsTranscript`). */
export function gooseOwnsTranscript(
  pin: Record<string, string>,
  root: string,
  conversationId: string,
): boolean | undefined {
  const db = gooseHumanDb(pin);
  if (!db) return undefined;
  return ownedAnswer(findGooseSession(db, root, conversationId));
}

/** Транскрипт кончившейся сессии ядра на месте — в базе Goose её каталога (`transcriptPresent`). */
export function gooseTranscriptPresent(
  _pin: Record<string, string>,
  conversationId: string,
  sessionDir?: string,
): boolean | undefined {
  if (!sessionDir) return undefined;
  const verdict = findGooseSession(gooseSessionDb(sessionDir), null, conversationId);
  return verdict === 'unreadable' ? undefined : verdict === 'owned';
}

/** Перенос разговора в дом сеанса: новая база с одной этой сессией, больше ничего. */
export function gooseResume(spec: SessionSpec): ResumeStage {
  const id = spec.resume?.conversationId ?? '';
  const source = resumeSourceOf(spec, GOOSE_HOME_DIR);
  if (typeof source === 'string') return { ok: false, reason: source };
  const db = source.kind === 'core' ? join(source.home, ROOT_DB) : gooseHumanDb(spec.env.pin);
  if (!db) return { ok: false, reason: resumeRefusal('goose', 'unreadable', id) };
  const verdict = findGooseSession(db, spec.cwd, id);
  if (verdict !== 'owned') return { ok: false, reason: resumeRefusal('goose', verdict, id) };
  return { ok: true, place: () => copyGooseSession(db, gooseSessionDb(spec.dir), id) };
}
