import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { MigrationTool } from '@agentdeck/contracts';
import { projectDirs } from '../sources/sources.ts';

/**
 * Каким инструментом проект ведёт миграции и какие миграции лежат в репозитории.
 * Только файлы: в базу этот модуль не ходит. Инструмент узнаётся по тому, что
 * он сам кладёт на диск, — именам файлов и их разметке, а не по догадке.
 */

export interface MigrationFile {
  /** Как миграцию записывает таблица учёта: версия, имя файла, `app.name`. */
  id: string;
  /** Для alembic: от какой ревизии отходит (`down_revision`). */
  parents?: string[];
}

export interface DetectedMigrations {
  tool: MigrationTool;
  /** Каталог относительно корня проекта. */
  dir: string;
  table: string;
  files: MigrationFile[];
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const head = (path: string, bytes = 4096): string => {
  try {
    return readFileSync(path, 'utf8').slice(0, bytes);
  } catch {
    return '';
  }
};

const rel = (root: string, path: string): string =>
  relative(root, path).split('\\').join('/') || '.';

/** Версии сравниваются как числа произвольной длины: `20240101120000` > `9`. */
export function compareVersions(a: string, b: string): number {
  const na = a.replace(/^0+/, '');
  const nb = b.replace(/^0+/, '');
  return na.length - nb.length || (na < nb ? -1 : na > nb ? 1 : 0);
}

const byVersion = (files: MigrationFile[]): MigrationFile[] =>
  [...files].sort((a, b) => compareVersions(a.id, b.id));

/** Каталоги миграций SQL, где их обычно держат Go, Rust и прочие. */
const SQL_DIRS = [
  'migrations',
  'db/migrations',
  'database/migrations',
  'sql/migrations',
  'migrate',
  'internal/db/migrations',
  'internal/migrations',
  'internal/database/migrations',
];

function prismaIn(dir: string): MigrationFile[] | undefined {
  const base = join(dir, 'prisma', 'migrations');
  if (!isDir(base)) return undefined;
  const files = list(base)
    .filter((name) => existsSync(join(base, name, 'migration.sql')))
    .map((id) => ({ id }));
  return files.length > 0 ? files : undefined;
}

function flywayIn(dir: string): { dir: string; files: MigrationFile[] } | undefined {
  for (const sub of ['src/main/resources/db/migration', 'db/migration']) {
    const base = join(dir, sub);
    const files = list(base)
      .map((name) => /^V([\d_.]+)__.+\.sql$/i.exec(name)?.[1])
      .filter((version): version is string => Boolean(version))
      .map((version) => ({ id: version.replace(/_/g, '.') }));
    if (files.length > 0) {
      return {
        dir: base,
        files: files.sort((a, b) => {
          const pa = a.id.split('.').map(Number);
          const pb = b.id.split('.').map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
            const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
            if (diff !== 0) return diff;
          }
          return 0;
        }),
      };
    }
  }
  return undefined;
}

/** Ревизии alembic: `revision = 'abc'`, `down_revision = 'def'` или кортеж при слиянии веток. */
function alembicIn(dir: string): { dir: string; files: MigrationFile[] } | undefined {
  const candidates: string[] = [];
  const ini = head(join(dir, 'alembic.ini'), 20_000);
  const location = /^\s*script_location\s*=\s*(.+)$/m.exec(ini)?.[1]?.trim();
  if (location) candidates.push(location.replace(/^%\(here\)s[\\/]/, ''));
  candidates.push('alembic', 'migrations');
  for (const candidate of candidates) {
    const base = join(dir, candidate, 'versions');
    const files: MigrationFile[] = [];
    for (const name of list(base).filter((item) => item.endsWith('.py'))) {
      const text = head(join(base, name), 8_000);
      const revision = /^revision\s*(?::\s*\w+\s*)?=\s*['"]([\w-]+)['"]/m.exec(text)?.[1];
      if (!revision) continue;
      const downRaw = /^down_revision\s*(?::[^=]+)?=\s*(.+)$/m.exec(text)?.[1] ?? '';
      const parents = [...downRaw.matchAll(/['"]([\w-]+)['"]/g)].map((match) => match[1] ?? '');
      files.push({ id: revision, parents });
    }
    if (files.length > 0) return { dir: base, files: alembicOrder(files) };
  }
  return undefined;
}

/** Ревизии от корня к голове: родитель раньше потомка, внутри уровня — по id. */
export function alembicOrder(files: MigrationFile[]): MigrationFile[] {
  const ids = new Set(files.map((file) => file.id));
  const ordered: MigrationFile[] = [];
  const placed = new Set<string>();
  let rest = [...files].sort((a, b) => a.id.localeCompare(b.id));
  while (rest.length > 0) {
    const ready = rest.filter((file) =>
      (file.parents ?? []).every((parent) => placed.has(parent) || !ids.has(parent)),
    );
    // Цикл в ревизиях — файлы испорчены; выводим остаток как есть, а не зависаем.
    const batch = ready.length > 0 ? ready : rest;
    for (const file of batch) {
      ordered.push(file);
      placed.add(file.id);
    }
    rest = rest.filter((file) => !placed.has(file.id));
  }
  return ordered;
}

/** Django: `<app>/migrations/0001_initial.py` рядом с `manage.py`. */
function djangoIn(dir: string): MigrationFile[] | undefined {
  if (!existsSync(join(dir, 'manage.py'))) return undefined;
  const files: MigrationFile[] = [];
  const apps = list(dir).filter((name) => isDir(join(dir, name, 'migrations')));
  // Проект бывает вложен на уровень глубже: `src/<app>/migrations`.
  for (const outer of list(dir).filter((name) => isDir(join(dir, name)) && !name.startsWith('.'))) {
    for (const inner of list(join(dir, outer))) {
      if (isDir(join(dir, outer, inner, 'migrations'))) apps.push(join(outer, inner));
    }
  }
  for (const app of apps) {
    const label = app.split(/[\\/]/).pop() ?? app;
    for (const name of list(join(dir, app, 'migrations'))) {
      if (/^\d{4}_\w+\.py$/.test(name)) files.push({ id: `${label}.${name.replace(/\.py$/, '')}` });
    }
  }
  return files.length > 0 ? files : undefined;
}

function railsIn(dir: string): MigrationFile[] | undefined {
  const files = list(join(dir, 'db', 'migrate'))
    .map((name) => /^(\d+)_\w+\.rb$/.exec(name)?.[1])
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }));
  return files.length > 0 ? byVersion(files) : undefined;
}

function knexIn(dir: string): { dir: string; files: MigrationFile[] } | undefined {
  if (!list(dir).some((name) => /^knexfile\.(c|m)?(j|t)s$/.test(name))) return undefined;
  const base = join(dir, 'migrations');
  const files = list(base)
    .filter((name) => /\.(c|m)?(j|t)s$/.test(name) && !name.endsWith('.d.ts'))
    .map((id) => ({ id }));
  return files.length > 0 ? { dir: base, files } : undefined;
}

/** SQL-миграции по номерам: golang-migrate, goose, sqlx, dbmate — различаются разметкой. */
function sqlNumberedIn(
  dir: string,
): { tool: MigrationTool; dir: string; table: string; files: MigrationFile[] } | undefined {
  const rust = existsSync(join(dir, 'Cargo.toml'));
  for (const sub of SQL_DIRS) {
    const base = join(dir, sub);
    const names = list(base).filter((name) => /^\d+_.+\.sql$/.test(name));
    if (names.length === 0) continue;
    const versions = [...new Set(names.map((name) => /^(\d+)_/.exec(name)?.[1] ?? ''))]
      .filter(Boolean)
      .map((id) => ({ id }));
    const sample = head(join(base, names[0] ?? ''));
    if (rust) {
      return { tool: 'sqlx', dir: base, table: '_sqlx_migrations', files: byVersion(versions) };
    }
    if (/^--\s*\+goose\s+up/im.test(sample)) {
      return { tool: 'goose', dir: base, table: 'goose_db_version', files: byVersion(versions) };
    }
    if (/^--\s*migrate:up/im.test(sample)) {
      return { tool: 'dbmate', dir: base, table: 'schema_migrations', files: byVersion(versions) };
    }
    if (names.some((name) => name.endsWith('.up.sql'))) {
      return {
        tool: 'golang-migrate',
        dir: base,
        table: 'schema_migrations',
        files: byVersion(versions),
      };
    }
  }
  return undefined;
}

/** Первый найденный инструмент — от корня проекта вглубь. */
export function detectMigrations(root: string): DetectedMigrations | undefined {
  for (const dir of projectDirs(root)) {
    const prisma = prismaIn(dir);
    if (prisma) {
      return {
        tool: 'prisma',
        dir: rel(root, join(dir, 'prisma', 'migrations')),
        table: '_prisma_migrations',
        files: prisma,
      };
    }
    const flyway = flywayIn(dir);
    if (flyway) {
      return {
        tool: 'flyway',
        dir: rel(root, flyway.dir),
        table: 'flyway_schema_history',
        files: flyway.files,
      };
    }
    const alembic = alembicIn(dir);
    if (alembic) {
      return {
        tool: 'alembic',
        dir: rel(root, alembic.dir),
        table: 'alembic_version',
        files: alembic.files,
      };
    }
    const django = djangoIn(dir);
    if (django)
      return { tool: 'django', dir: rel(root, dir), table: 'django_migrations', files: django };
    const rails = railsIn(dir);
    if (rails) {
      return {
        tool: 'rails',
        dir: rel(root, join(dir, 'db', 'migrate')),
        table: 'schema_migrations',
        files: rails,
      };
    }
    const knex = knexIn(dir);
    if (knex)
      return {
        tool: 'knex',
        dir: rel(root, knex.dir),
        table: 'knex_migrations',
        files: knex.files,
      };
    const numbered = sqlNumberedIn(dir);
    if (numbered) return { ...numbered, dir: rel(root, numbered.dir) };
  }
  return undefined;
}
