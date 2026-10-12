import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alembicOrder, compareVersions, detectMigrations } from './detect.ts';
import { compareMigrations } from './migrations.ts';

let root: string;
const put = (path: string, text = ''): void => {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'db-migrations-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('detectMigrations', () => {
  it('golang-migrate по парам .up/.down и порядку номеров', () => {
    put('backend/migrations/000010_add_orders.up.sql', 'create table orders();');
    put('backend/migrations/000010_add_orders.down.sql');
    put('backend/migrations/000002_users.up.sql', 'create table users();');
    expect(detectMigrations(root)).toEqual({
      tool: 'golang-migrate',
      dir: 'backend/migrations',
      table: 'schema_migrations',
      files: [{ id: '000002' }, { id: '000010' }],
    });
  });

  it('goose и dbmate различаются разметкой файла, sqlx — по Cargo.toml', () => {
    put('db/migrations/20240101_init.sql', '-- +goose Up\ncreate table a();');
    expect(detectMigrations(root)?.tool).toBe('goose');
    put('db/migrations/20240101_init.sql', '-- migrate:up\ncreate table a();');
    expect(detectMigrations(root)?.tool).toBe('dbmate');
    put('Cargo.toml', '[package]');
    expect(detectMigrations(root)?.tool).toBe('sqlx');
  });

  it('prisma, flyway, rails, knex, django', () => {
    put('prisma/migrations/20240101000000_init/migration.sql');
    expect(detectMigrations(root)).toMatchObject({
      tool: 'prisma',
      files: [{ id: '20240101000000_init' }],
    });
    rmSync(join(root, 'prisma'), { recursive: true });

    put('svc/src/main/resources/db/migration/V1_1__more.sql');
    put('svc/src/main/resources/db/migration/V1__init.sql');
    put('svc/src/main/resources/db/migration/R__views.sql');
    expect(detectMigrations(root)).toMatchObject({
      tool: 'flyway',
      files: [{ id: '1' }, { id: '1.1' }],
    });
    rmSync(join(root, 'svc'), { recursive: true });

    put('db/migrate/20240102_add.rb');
    expect(detectMigrations(root)).toMatchObject({ tool: 'rails', files: [{ id: '20240102' }] });
    rmSync(join(root, 'db'), { recursive: true });

    put('knexfile.js');
    put('migrations/20240101_init.js');
    expect(detectMigrations(root)).toMatchObject({
      tool: 'knex',
      files: [{ id: '20240101_init.js' }],
    });
    rmSync(join(root, 'knexfile.js'));
    rmSync(join(root, 'migrations'), { recursive: true });

    put('manage.py');
    put('shop/migrations/0001_initial.py');
    put('shop/migrations/__init__.py');
    expect(detectMigrations(root)).toMatchObject({
      tool: 'django',
      files: [{ id: 'shop.0001_initial' }],
    });
  });

  it('alembic — ревизии по цепочке down_revision', () => {
    put('alembic.ini', '[alembic]\nscript_location = alembic\n');
    put('alembic/versions/b.py', "revision = 'bbb'\ndown_revision = 'aaa'\n");
    put('alembic/versions/a.py', "revision = 'aaa'\ndown_revision = None\n");
    put(
      'alembic/versions/c.py',
      "revision: str = 'ccc'\ndown_revision: Union[str, None] = 'bbb'\n",
    );
    expect(detectMigrations(root)?.files.map((file) => file.id)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('проект без миграций — ничего', () => {
    put('src/index.ts');
    expect(detectMigrations(root)).toBeUndefined();
  });
});

describe('compareMigrations', () => {
  const numbered = {
    tool: 'golang-migrate' as const,
    dir: 'migrations',
    table: 'schema_migrations',
    files: [{ id: '1' }, { id: '2' }, { id: '3' }],
  };

  it('golang-migrate: применено всё до текущей версии, dirty виден', () => {
    expect(compareMigrations(numbered, { applied: [], current: '2', dirty: true })).toMatchObject({
      migrations: [
        { id: '1', applied: true },
        { id: '2', applied: true },
        { id: '3', applied: false },
      ],
      orphaned: [],
      dirty: true,
    });
  });

  it('версия в базе без файла — осиротевшая', () => {
    expect(compareMigrations(numbered, { applied: [], current: '7' }).orphaned).toEqual(['7']);
    const rails = { ...numbered, tool: 'rails' as const };
    expect(compareMigrations(rails, { applied: ['0001', '9'] })).toMatchObject({
      migrations: [
        { id: '1', applied: true },
        { id: '2', applied: false },
        { id: '3', applied: false },
      ],
      orphaned: ['9'],
    });
  });

  it('alembic: голова в базе означает всю цепочку под ней', () => {
    const files = alembicOrder([
      { id: 'ccc', parents: ['bbb'] },
      { id: 'aaa', parents: [] },
      { id: 'bbb', parents: ['aaa'] },
    ]);
    const info = compareMigrations(
      { tool: 'alembic', dir: 'alembic/versions', table: 'alembic_version', files },
      { applied: ['bbb'] },
    );
    expect(info.migrations).toEqual([
      { id: 'aaa', applied: true },
      { id: 'bbb', applied: true },
      { id: 'ccc', applied: false },
    ]);
  });

  it('версии сравниваются как числа', () => {
    expect(compareVersions('10', '9')).toBeGreaterThan(0);
    expect(compareVersions('0002', '2')).toBe(0);
  });
});
