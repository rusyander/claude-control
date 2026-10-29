import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceRecipe } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  EPHEMERAL_LABEL,
  engineHandle,
  execIn,
  listByLabels,
  runEngine,
  type EngineHandle,
} from '../../platform/container-engine.ts';
import { localImageOf, PG_CANDIDATES } from '../../platform/__fixtures__/engine-stub.ts';
import { rewriteEnvText } from '../env/rewrite.ts';
import { startService, stopService } from '../services/index.ts';
import {
  destructiveFindings,
  migrationPlan,
  normalizeSchema,
  postgresIo,
  runMigrations,
  type MigrationFile,
  type MigrationIo,
} from './migration.ts';

/**
 * Класс `migration` (04:128-129) и P84. Модульная часть — разбор форматов, находки, up/down по
 * подделке исполнителя. Интеграция — НАСТОЯЩИЙ Postgres в контейнере задачи: `.env` копии
 * смотрел на «прод» (TCP-слушатель, считающий соединения), окружение переписано на контейнер,
 * инструмент миграций проекта (читает только `.env`) отработал — таблица есть в контейнере,
 * «прод» не получил ни одного соединения; затем класс прогнал фикстуру up → diff → down.
 */

const ZONE_LABEL = 'agentdeck.zone-f-test';
// Значение метки — своё у прогона файла: уборка `afterAll` соседнего файла (параллельно) иначе
// снесла бы мой живой контейнер посреди работы (pg_dump exit 137).
const ZONE_RUN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const here = fileURLToPath(new URL('./__fixtures__/migration/', import.meta.url));

function fixtureFiles(): MigrationFile[] {
  const dir = join(here, 'migrations');
  return readdirSync(dir).map((name) => ({
    path: `db/migrations/${name}`,
    text: readFileSync(join(dir, name), 'utf8'),
  }));
}

describe('migration plan and findings (all three tool formats)', () => {
  it('pairs .up/.down, splits dbmate and goose sections, keeps plain .sql up-only, orders by name', () => {
    const plan = migrationPlan([
      ...fixtureFiles(),
      {
        path: 'db/migrations/003_goose.sql',
        text: '-- +goose Up\n-- +goose StatementBegin\nCREATE INDEX i ON pets(name);\n-- +goose StatementEnd\n-- +goose Down\nDROP INDEX i;\n',
      },
      { path: 'db/migrations/004_plain.sql', text: 'SELECT 1;' },
      { path: 'db/README.md', text: '# not sql' },
    ]);
    expect(plan.map((s) => [s.file, s.down !== null])).toEqual([
      ['db/migrations/001_pets.up.sql', true],
      ['db/migrations/002_legacy.sql', true],
      ['db/migrations/003_goose.sql', true],
      ['db/migrations/004_plain.sql', false],
    ]);
    expect(plan[2]?.up.trim()).toBe('CREATE INDEX i ON pets(name);');
    expect(plan[1]?.down?.trim()).toBe('ALTER TABLE pets DROP COLUMN tag;');
  });
  it('destructive statements of the up half are findings; comments and safe DDL are not', () => {
    const got = destructiveFindings(
      'm.sql',
      [
        '-- DROP TABLE commented;',
        'CREATE TABLE a (id int);',
        'DROP TABLE legacy;',
        'ALTER TABLE a DROP COLUMN b;',
        'TRUNCATE t;',
        'DELETE FROM t;',
        'DELETE FROM t WHERE id = 1;',
        'ALTER TABLE a ALTER COLUMN id TYPE bigint;',
        '/* DROP SCHEMA x; */',
      ].join('\n'),
    );
    expect(got.map((f) => f.kind)).toEqual([
      'drop',
      'drop',
      'truncate',
      'delete-without-where',
      'alter-type',
    ]);
  });
  it('B2-F04: destructive forms inside DO bodies, CTEs, other objects and after quoted "--" are findings', () => {
    const kinds = (sql: string) => destructiveFindings('m.sql', sql).map((f) => f.kind);
    expect(kinds('DO $$ BEGIN DROP TABLE legacy; END $$;')).toEqual(['drop']);
    expect(kinds('DO $body$ BEGIN DELETE FROM t; END $body$;')).toEqual(['delete-without-where']);
    expect(kinds('DROP FUNCTION f();')).toEqual(['drop']);
    expect(kinds('DROP SEQUENCE s;')).toEqual(['drop']);
    expect(kinds('DROP EXTENSION hstore;')).toEqual(['drop']);
    expect(kinds('DROP TRIGGER t ON a;')).toEqual(['drop']);
    expect(kinds('UPDATE users SET email = NULL;')).toEqual(['update-without-where']);
    expect(kinds('UPDATE users SET email = NULL WHERE id = 1;')).toEqual([]);
    expect(
      kinds('WITH gone AS (DELETE FROM orders RETURNING id) SELECT count(*) FROM gone;'),
    ).toEqual(['delete-without-where']);
    expect(kinds("INSERT INTO a VALUES ('--'); DROP TABLE b;")).toEqual(['drop']);
    expect(kinds("INSERT INTO a VALUES ('/*'); DROP TABLE c; -- */")).toEqual(['drop']);
    // Слова внутри строк и комментариев — не операторы.
    expect(kinds("INSERT INTO log VALUES ('DROP TABLE x; DELETE FROM y');")).toEqual([]);
    expect(kinds('CREATE FUNCTION g() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;')).toEqual([]);
  });
  it('UPDATE without WHERE is its own destructive kind, never the catch-all `other`', () => {
    const kinds = (sql: string) => destructiveFindings('m.sql', sql).map((f) => f.kind);
    expect(kinds('UPDATE ONLY users u SET email = NULL;')).toEqual(['update-without-where']);
    expect(
      kinds('WITH t AS (UPDATE orders SET paid = false RETURNING id) SELECT 1 FROM t;'),
    ).toEqual(['update-without-where']);
    // Переименование — по-прежнему `other`: своего вида у него нет.
    expect(kinds('ALTER TABLE a RENAME TO b;')).toEqual(['other']);
  });
  it('A2-F13: golang-migrate / goose versions apply in numeric order, not by string', () => {
    const plan = migrationPlan([
      { path: 'm/10_drop.up.sql', text: 'SELECT 10;' },
      { path: 'm/1_init.up.sql', text: 'SELECT 1;' },
      { path: 'm/2_add.up.sql', text: 'SELECT 2;' },
      { path: 'm/20240101120000_ts.sql', text: 'SELECT 3;' },
      { path: 'm/9_nine.sql', text: 'SELECT 9;' },
    ]);
    expect(plan.map((s) => s.file)).toEqual([
      'm/1_init.up.sql',
      'm/2_add.up.sql',
      'm/9_nine.sql',
      'm/10_drop.up.sql',
      'm/20240101120000_ts.sql',
    ]);
  });
});

function fakeIo(fail?: string): MigrationIo & { log: string[] } {
  const tables = new Set<string>();
  const log: string[] = [];
  return {
    log,
    async apply(sql, file) {
      log.push(file);
      if (fail && file === fail) return { ok: false, tail: 'ERROR: boom' };
      for (const m of sql.matchAll(/CREATE TABLE (\w+)/gi)) tables.add(m[1] as string);
      for (const m of sql.matchAll(/DROP TABLE (\w+)/gi)) tables.delete(m[1] as string);
      return { ok: true };
    },
    async schema() {
      return {
        value: [...tables]
          .sort()
          .map((t) => `CREATE TABLE public.${t} ();`)
          .join('\n'),
      };
    },
  };
}

describe('runMigrations over a recorded executor', () => {
  it('up → schema diff → down reverts; destructive finding recorded', async () => {
    const io = fakeIo();
    const got = await runMigrations(migrationPlan(fixtureFiles()), io);
    expect(got).toMatchObject({
      value: {
        applied: ['db/migrations/001_pets.up.sql', 'db/migrations/002_legacy.sql'],
        down: 'reverted',
        schemaDiff: { added: ['CREATE TABLE public.pets ();'], removed: [] },
        findings: [{ file: 'db/migrations/002_legacy.sql', kind: 'drop' }],
        failed: null,
      },
    });
    expect(io.log.slice(-2)).toEqual([
      'db/migrations/002_legacy.sql (down)',
      'db/migrations/001_pets.up.sql (down)',
    ]);
  });
  it('a failing up stops at that file and names it (red), later files not applied', async () => {
    const got = await runMigrations(
      migrationPlan(fixtureFiles()),
      fakeIo('db/migrations/001_pets.up.sql'),
    );
    expect(got).toMatchObject({
      value: {
        applied: [],
        failed: { file: 'db/migrations/001_pets.up.sql', tail: 'ERROR: boom' },
      },
    });
  });
  it('schema unreadable → unknown (no verdict), never an empty diff', async () => {
    const io: MigrationIo = {
      apply: async () => ({ ok: true }),
      schema: async () => ({ unknown: 'pg_dump exit 1' }),
    };
    expect(await runMigrations(migrationPlan(fixtureFiles()), io)).toEqual({
      unknown: 'schema before: pg_dump exit 1',
    });
  });
  it('dump noise (comments, SET, psql meta) is not schema', () => {
    expect(
      normalizeSchema(
        '-- c\nSET x = 1;\n\\restrict k\nSELECT pg_catalog.set_config(1);\n\nCREATE TABLE a ();',
      ),
    ).toEqual(['CREATE TABLE a ();']);
  });
});

// ── P84: настоящий Postgres задачи ─────────────────────────────────────────────────────────

const slack = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * 6);
  return { cancel: () => clearTimeout(t) };
};
const engine = await engineHandle({ setTimer: slack });
const h: EngineHandle | undefined = 'value' in engine ? engine.value : undefined;
const pgImage = h ? await localImageOf(h, PG_CANDIDATES) : undefined;
const PG_IMAGE = pgImage ?? PG_CANDIDATES.join(' / ');
const havePg = pgImage !== undefined;
// Внутри контейнера (Linux-прогон через сокет хоста) опубликованный порт живёт на хосте движка,
// не здесь: TCP до сервиса задачи отсюда не дойти — блок пропущен с этой причиной.
const inContainer = existsSync('/.dockerenv');
function skipReason(): string {
  if (!h) return `engine: ${'unknown' in engine ? engine.unknown : 'absent'}`;
  if (!havePg) return `no local ${PG_IMAGE}`;
  return 'published ports are on the engine host, not inside this container';
}
const skipWhy = skipReason();
const temps: string[] = [];

afterAll(async () => {
  if (h) {
    const left = await listByLabels(h, { [EPHEMERAL_LABEL]: '1', [ZONE_LABEL]: ZONE_RUN });
    const ids = 'value' in left ? left.value.map((row) => row.id) : [];
    if (ids.length > 0) await runEngine(h, ['rm', '-f', '-v', ...ids], { timeoutMs: 120_000 });
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function prodListener(): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((socket) => {
    hits += 1;
    socket.destroy();
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      done({ server, port, hits: () => hits });
    });
  });
}

// Имя блока постоянное — по нему кейс блока тестов связан с тестом; причина пропуска — своей строкой.
const p84Runs = h !== undefined && havePg && !inContainer;
if (!p84Runs) it.skip(`P84 skipped: ${skipWhy}`, () => undefined);
describe.runIf(p84Runs)(
  'P84 fixture migration reaches only the task container (real postgres)',
  { timeout: 240_000 },
  () => {
    it('copy .env pointed at prod; after the rewrite the project tool migrates the container and prod sees zero connections', async () => {
      const prod = await prodListener();
      const task = newId();
      const recipe: ServiceRecipe = {
        name: 'db',
        source: 'compose',
        image: PG_IMAGE,
        ports: [5432],
        env: { POSTGRES_DB: 'app' },
        scheme: 'postgres',
      };
      const copy = mkdtempSync(join(tmpdir(), 'agentdeck-p84-copy-'));
      temps.push(copy);
      try {
        const started = await startService(h!, task, recipe, {
          extraLabels: { [ZONE_LABEL]: ZONE_RUN },
          readyTimeoutMs: 120_000,
        });
        expect(started).toMatchObject({
          value: { recipe: 'db', reused: false, endpoint: { url: expect.any(String) } },
        });
        if (!('value' in started) || !started.value.endpoint) throw new Error('no endpoint');
        const { engineId, endpoint, hostPort } = started.value;
        // Пароль рецепта (его нет) в адрес не попал; адрес — только 127.0.0.1 и порт контейнера.
        expect(endpoint.url).toBe(`postgres://postgres@127.0.0.1:${hostPort}/app`);

        const prodEnv = `DATABASE_URL=postgres://prod:secret@127.0.0.1:${prod.port}/prod\nAPP_NAME=pets\n`;
        const rewritten = rewriteEnvText(prodEnv, [endpoint]);
        expect(rewritten.changes).toEqual([
          { name: 'DATABASE_URL', action: 'rewritten', scheme: 'postgres', why: 'db' },
        ]);
        expect(rewritten.text).not.toContain(String(prod.port));
        writeFileSync(join(copy, '.env'), rewritten.text);

        const tool = spawnSync(
          process.execPath,
          [join(here, 'env-migrate.mjs'), join(here, 'env-tool.sql')],
          { cwd: copy, encoding: 'utf8', timeout: 60_000 },
        );
        expect({ code: tool.status, err: tool.stderr.trim() }).toEqual({ code: 0, err: '' });
        expect(tool.stdout).toContain(`migrated 127.0.0.1:${hostPort}/app`);

        const inside = await execIn(h!, engineId, [
          'psql',
          '-U',
          'postgres',
          '-d',
          'app',
          '-tAc',
          "SELECT to_regclass('public.from_env_tool')",
        ]);
        expect(inside).toMatchObject({ code: 0, stdout: 'from_env_tool\n' });
        expect(prod.hits()).toBe(0);

        // Класс миграций на том же контейнере: up → diff → down, разрушающая строка — находка.
        const outcome = await runMigrations(
          migrationPlan(fixtureFiles()),
          postgresIo(h!, engineId, { user: 'postgres', db: 'app' }),
        );
        expect(outcome).toMatchObject({
          value: {
            applied: ['db/migrations/001_pets.up.sql', 'db/migrations/002_legacy.sql'],
            down: 'reverted',
            findings: [{ kind: 'drop', statement: 'DROP TABLE legacy' }],
            failed: null,
          },
        });
        if ('value' in outcome) {
          expect(outcome.value.schemaDiff.removed).toEqual([]);
          expect(outcome.value.schemaDiff.added).toContain('CREATE TABLE public.pets (');
          expect(outcome.value.schemaDiff.added).toContain('    tag text');
        }
        expect(prod.hits()).toBe(0);

        expect(await stopService(h!, task, 'db', engineId)).toEqual({
          verified: `container ${engineId} absent`,
        });
      } finally {
        await new Promise((done) => prod.server.close(done));
      }
    });
  },
);
