import type { MigrationsInfo } from '@agentdeck/contracts';
import type pg from 'pg';
import { DbError, withReadOnly } from '../client.ts';
import type { DbTarget } from '../database.types.ts';
import { compareVersions, detectMigrations, type DetectedMigrations } from './detect.ts';

/**
 * Состояние миграций: файлы проекта против таблицы учёта в базе. Только
 * чтение — ни применить, ни откатить панель ничего не может, и кнопок таких
 * нет: это решение человека и его инструмента.
 */

/** Что записано в базе. `current` — у golang-migrate учёт держит одну версию. */
export interface MigrationHistory {
  applied: string[];
  current?: string;
  dirty?: boolean;
}

/** Таблица учёта: запросы по инструменту. Значения текстом — тип версии у всех свой. */
async function readHistory(
  client: pg.Client,
  detected: DetectedMigrations,
): Promise<MigrationHistory> {
  const rows = async (sql: string): Promise<Record<string, string | null>[]> =>
    (await client.query<Record<string, string | null>>(sql)).rows;
  switch (detected.tool) {
    case 'golang-migrate': {
      const [row] = await rows(
        'SELECT version::text AS version, dirty::text AS dirty FROM schema_migrations LIMIT 1',
      );
      if (!row?.version) return { applied: [] };
      return {
        applied: [],
        current: row.version,
        dirty: row.dirty === 'true' || row.dirty === 't',
      };
    }
    case 'goose': {
      // Журнал: последняя запись по версии решает, применена ли она.
      const list = await rows(
        `SELECT DISTINCT ON (version_id) version_id::text AS id, is_applied::text AS applied
           FROM goose_db_version ORDER BY version_id, id DESC`,
      );
      return {
        applied: list
          .filter((row) => (row.applied === 'true' || row.applied === 't') && row.id !== '0')
          .map((row) => row.id ?? ''),
      };
    }
    case 'flyway': {
      const list = await rows(
        'SELECT version, success::text AS success FROM flyway_schema_history WHERE version IS NOT NULL',
      );
      const failed = list.some((row) => row.success === 'false' || row.success === 'f');
      return {
        applied: list
          .filter((row) => row.success === 'true' || row.success === 't')
          .map((row) => row.version ?? ''),
        ...(failed ? { dirty: true } : {}),
      };
    }
    case 'alembic':
      return {
        applied: (await rows('SELECT version_num AS id FROM alembic_version')).map(
          (row) => row.id ?? '',
        ),
      };
    case 'django':
      return {
        applied: (await rows("SELECT app || '.' || name AS id FROM django_migrations")).map(
          (row) => row.id ?? '',
        ),
      };
    case 'prisma': {
      const list = await rows(
        `SELECT migration_name AS id, (finished_at IS NULL AND rolled_back_at IS NULL)::text AS failed
           FROM _prisma_migrations WHERE rolled_back_at IS NULL`,
      );
      const failed = list.some((row) => row.failed === 'true' || row.failed === 't');
      return {
        applied: list
          .filter((row) => row.failed !== 'true' && row.failed !== 't')
          .map((row) => row.id ?? ''),
        ...(failed ? { dirty: true } : {}),
      };
    }
    case 'knex':
      return {
        applied: (await rows('SELECT name AS id FROM knex_migrations')).map((row) => row.id ?? ''),
      };
    case 'sqlx': {
      const list = await rows(
        'SELECT version::text AS id, success::text AS success FROM _sqlx_migrations',
      );
      const failed = list.some((row) => row.success === 'false' || row.success === 'f');
      return {
        applied: list
          .filter((row) => row.success === 'true' || row.success === 't')
          .map((row) => row.id ?? ''),
        ...(failed ? { dirty: true } : {}),
      };
    }
    case 'dbmate':
    case 'rails':
      return {
        applied: (await rows('SELECT version::text AS id FROM schema_migrations')).map(
          (row) => row.id ?? '',
        ),
      };
  }
}

const sameVersion = (a: string, b: string): boolean => compareVersions(a, b) === 0;

/** Сравнить файлы с учётом. Чистая функция — тесты кормят её историей без базы. */
export function compareMigrations(
  detected: DetectedMigrations,
  history: MigrationHistory,
): MigrationsInfo {
  const base = { tool: detected.tool, dir: detected.dir, table: detected.table };
  const numeric =
    detected.tool !== 'alembic' &&
    detected.tool !== 'django' &&
    detected.tool !== 'prisma' &&
    detected.tool !== 'knex' &&
    detected.tool !== 'flyway';
  const matches = (fileId: string, recorded: string): boolean =>
    numeric ? sameVersion(fileId, recorded) : fileId === recorded;

  if (detected.tool === 'golang-migrate') {
    const current = history.current;
    return {
      ...base,
      migrations: detected.files.map((file) => ({
        id: file.id,
        applied: current !== undefined && compareVersions(file.id, current) <= 0,
      })),
      orphaned:
        current && !detected.files.some((file) => sameVersion(file.id, current)) ? [current] : [],
      ...(history.dirty ? { dirty: true } : {}),
    };
  }

  let applied = new Set(history.applied);
  if (detected.tool === 'alembic') {
    // Учёт alembic хранит только головы: применено всё, что ниже них по цепочке.
    const parents = new Map(detected.files.map((file) => [file.id, file.parents ?? []]));
    const reached = new Set<string>();
    const stack = [...history.applied];
    while (stack.length > 0) {
      const id = stack.pop() ?? '';
      if (reached.has(id)) continue;
      reached.add(id);
      stack.push(...(parents.get(id) ?? []));
    }
    applied = reached;
  }

  const recorded = [...applied];
  return {
    ...base,
    migrations: detected.files.map((file) => ({
      id: file.id,
      applied: recorded.some((item) => matches(file.id, item)),
    })),
    orphaned: recorded
      .filter((item) => item && !detected.files.some((file) => matches(file.id, item)))
      .sort((a, b) => (numeric ? compareVersions(a, b) : a.localeCompare(b))),
    ...(history.dirty ? { dirty: true } : {}),
  };
}

/**
 * Состояние миграций проекта. Без подключения — только файлы. База недоступна
 * или нет прав на таблицу — файлы и причина, а не отказ целиком.
 */
export async function describeMigrations(
  root: string,
  target: DbTarget | undefined,
  timeoutMs: number,
): Promise<MigrationsInfo> {
  const detected = detectMigrations(root);
  if (!detected) return { migrations: [], orphaned: [] };
  const filesOnly: MigrationsInfo = {
    tool: detected.tool,
    dir: detected.dir,
    table: detected.table,
    migrations: detected.files.map((file) => ({ id: file.id, applied: false })),
    orphaned: [],
  };
  if (!target) return filesOnly;
  try {
    const history = await withReadOnly(target, { timeoutMs }, (client) =>
      readHistory(client, detected),
    );
    return compareMigrations(detected, history);
  } catch (error) {
    if (error instanceof DbError && error.sqlState === '42P01')
      return { ...filesOnly, neverRun: true };
    return { ...filesOnly, error: error instanceof Error ? error.message : String(error) };
  }
}
