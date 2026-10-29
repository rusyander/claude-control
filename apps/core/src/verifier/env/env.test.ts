import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyEnv, rewriteEnv, rewriteEnvText } from './index.ts';

/**
 * Окружение копии (04:92-93, P84): сервисная переменная узнаётся по имени и по схеме значения;
 * в копии адрес сервиса указывает только на эфемерный контейнер задачи или закомментирован —
 * без старого значения (в нём мог быть адрес настоящей базы с паролем).
 */

const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-core-env-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('classifyEnv: names and schemes', () => {
  it('classifies service vars by name and by value scheme; non-services and file DBs are left out', () => {
    const rows = classifyEnv(
      [
        { name: 'DATABASE_URL', value: 'postgres://u:p@localhost:5432/app' },
        { name: 'CACHE', value: 'rediss://cache.prod.example.com:6380' },
        { name: 'PGHOST', value: 'localhost' },
        { name: 'MONGO_URI', value: 'mongodb+srv://cluster0.example.net/db' },
        { name: 'BROKER_URL', value: 'amqp://guest@127.0.0.1:5672' },
        { name: 'KAFKA_BROKERS' },
        { name: 'MYSQL_HOST', value: 'db.internal' },
        { name: 'ORDERS_DB', value: '' },
        { name: 'SQLITE_DB', value: 'sqlite:///tmp/x.db' },
        { name: 'LOG_LEVEL', value: 'debug' },
        { name: 'API_URL', value: 'https://api.example.com' },
      ],
      [{ host: '127.0.0.1', port: 5672 }],
    );
    expect(rows).toEqual([
      { name: 'DATABASE_URL', scheme: 'postgres', hostKind: 'local-non-ephemeral', source: 'name' },
      { name: 'CACHE', scheme: 'redis', hostKind: 'remote', source: 'scheme' },
      { name: 'PGHOST', scheme: 'postgres', hostKind: 'local-non-ephemeral', source: 'name' },
      { name: 'MONGO_URI', scheme: 'mongodb', hostKind: 'remote', source: 'name' },
      { name: 'BROKER_URL', scheme: 'amqp', hostKind: 'ephemeral', source: 'name' },
      { name: 'KAFKA_BROKERS', scheme: 'kafka', hostKind: 'remote', source: 'name' },
      { name: 'MYSQL_HOST', scheme: 'mysql', hostKind: 'remote', source: 'name' },
      { name: 'ORDERS_DB', scheme: 'other', hostKind: 'remote', source: 'name' },
    ]);
  });
});

describe('rewriteEnv: the copy points only at ephemeral services (P84)', () => {
  const endpoints = [{ recipe: 'compose:db', url: 'postgres://test:test@127.0.0.1:54329/app' }];

  it('rewrites URL and host+port pairs to the task container, comments out the rest without the old value', () => {
    const before = [
      'DATABASE_URL="postgres://admin:s3cret@prod-db.example.com:5432/app"',
      'PGHOST=prod-db.example.com',
      'PGPORT=5432',
      'REDIS_URL=redis://cache.example.com:6379',
      'LOG_LEVEL=debug',
      '',
    ].join('\n');
    const out = rewriteEnvText(before, endpoints);
    expect(out.text.split('\n')).toEqual([
      'DATABASE_URL="postgres://test:test@127.0.0.1:54329/app"',
      'PGHOST=127.0.0.1',
      'PGPORT=54329',
      '# agentdeck-removed: REDIS_URL [redis url] — no ephemeral redis container for this task',
      'LOG_LEVEL=debug',
      '',
    ]);
    expect(out.text).not.toContain('s3cret');
    expect(out.text).not.toContain('cache.example.com');
    expect(out.changes.map((c) => `${c.name}:${c.action}`)).toEqual([
      'DATABASE_URL:rewritten',
      'PGHOST:rewritten',
      'PGPORT:rewritten',
      'REDIS_URL:removed',
    ]);
  });

  it('rewrites .env files of a real copy dir in the root and stack roots; samples and others untouched', async () => {
    const copy = join(scratch, 'copy');
    mkdirSync(join(copy, 'api'), { recursive: true });
    writeFileSync(join(copy, '.env'), 'DATABASE_URL=postgres://a:b@prod:5432/x\r\n');
    writeFileSync(join(copy, 'api', '.env.local'), 'REDIS_HOST=cache.prod\n');
    writeFileSync(join(copy, '.env.example'), 'DATABASE_URL=postgres://prod:5432/x\n');
    writeFileSync(join(copy, 'notes.env.txt'), 'DATABASE_URL=postgres://prod:5432/x\n');
    const report = await rewriteEnv(copy, endpoints, ['', 'api', 'missing']);
    expect(report).toEqual({
      value: [
        {
          file: '.env',
          changes: [
            { name: 'DATABASE_URL', action: 'rewritten', scheme: 'postgres', why: 'compose:db' },
          ],
        },
        {
          file: 'api/.env.local',
          changes: [
            {
              name: 'REDIS_HOST',
              action: 'removed',
              scheme: 'redis',
              why: 'no ephemeral redis container for this task',
            },
          ],
        },
      ],
    });
    expect(readFileSync(join(copy, '.env'), 'utf8')).toBe(
      'DATABASE_URL=postgres://test:test@127.0.0.1:54329/app\r\n',
    );
    expect(readFileSync(join(copy, '.env.example'), 'utf8')).toContain('prod:5432');
  });

  it('a host without a port var gets the container port pinned; cross-family and split-file ports follow', async () => {
    // Хост на 127.0.0.1 без порта — клиент возьмёт 5432 по умолчанию, то есть локальную базу человека.
    const noPort = rewriteEnvText('DB_HOST=prod-db.example.com\n', endpoints);
    expect(noPort.text).toBe('DB_HOST=127.0.0.1\nDB_PORT=54329\n');
    const cross = rewriteEnvText('POSTGRES_HOST=prod-db\nPGPORT=5432\n', endpoints);
    expect(cross.text).toBe('POSTGRES_HOST=127.0.0.1\nPOSTGRES_PORT=54329\nPGPORT=54329\n');
    const pg = rewriteEnvText('PGHOST=prod-db\n', endpoints);
    expect(pg.text).toBe('PGHOST=127.0.0.1\nPGPORT=54329\n');
    const copy = join(scratch, 'split');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, '.env'), 'DB_HOST=prod-db\n');
    writeFileSync(join(copy, '.env.local'), 'DB_PORT=5432\n');
    const report = await rewriteEnv(copy, endpoints, ['']);
    expect('value' in report).toBe(true);
    expect(readFileSync(join(copy, '.env'), 'utf8')).toBe('DB_HOST=127.0.0.1\n');
    expect(readFileSync(join(copy, '.env.local'), 'utf8')).toBe('DB_PORT=54329\n');
  });

  it('address vars that are neither URL nor *_HOST are rewritten or removed, never kept', () => {
    const before = [
      'KAFKA_BOOTSTRAP_SERVERS=kafka.prod:9092',
      'KAFKA_BROKERS=kafka.prod:9092',
      'REDIS_ADDR=cache.prod:6379',
      'MONGO_HOSTS=m1.prod,m2.prod',
      'DB_SERVER=prod-sql',
      'RABBITMQ_ADDRESS=mq.prod',
      'KAFKA_TOPIC=orders',
      '',
    ].join('\n');
    const out = rewriteEnvText(before, [
      ...endpoints,
      { recipe: 'compose:kafka', url: 'kafka://127.0.0.1:59092' },
    ]);
    expect(out.text.split('\n')).toEqual([
      'KAFKA_BOOTSTRAP_SERVERS=127.0.0.1:59092',
      'KAFKA_BROKERS=127.0.0.1:59092',
      '# agentdeck-removed: REDIS_ADDR [redis address] — no ephemeral redis container for this task',
      '# agentdeck-removed: MONGO_HOSTS [mongodb address] — no ephemeral mongodb container for this task',
      'DB_SERVER=127.0.0.1:54329',
      '# agentdeck-removed: RABBITMQ_ADDRESS [amqp address] — no ephemeral amqp container for this task',
      'KAFKA_TOPIC=orders',
      '',
    ]);
    for (const host of ['kafka.prod', 'cache.prod', 'm1.prod', 'prod-sql', 'mq.prod']) {
      expect(out.text).not.toContain(host);
    }
  });

  it('a removed line keeps a slot that a later rewrite with a matching endpoint restores', () => {
    const first = rewriteEnvText(
      'DATABASE_URL=postgres://admin:s3cret@prod:5432/app\nCACHE=rediss://cache.prod:6380\n',
      [],
    );
    expect(first.text).not.toContain('s3cret');
    const second = rewriteEnvText(first.text, [
      ...endpoints,
      { recipe: 'compose:cache', url: 'redis://127.0.0.1:56379' },
    ]);
    expect(second.text).toBe(
      'DATABASE_URL=postgres://test:test@127.0.0.1:54329/app\nCACHE=redis://127.0.0.1:56379\n',
    );
    expect(second.changes.map((c) => `${c.name}:${c.action}`)).toEqual([
      'DATABASE_URL:rewritten',
      'CACHE:rewritten',
    ]);
    // Слот старого вида тоже восстанавливается по имени.
    const legacy = rewriteEnvText(
      '# agentdeck: DATABASE_URL removed — no ephemeral postgres container for this task\n',
      endpoints,
    );
    expect(legacy.text).toBe('DATABASE_URL=postgres://test:test@127.0.0.1:54329/app\n');
  });

  it('a web DSN is not a service var; an unknown protocol is never taken by the single-DB fallback', () => {
    const out = rewriteEnvText(
      'SENTRY_DSN=https://key@o1.ingest.sentry.io/42\nORDERS_DSN=sqlserver://prod:1433\n',
      endpoints,
    );
    expect(out.text).toBe(
      'SENTRY_DSN=https://key@o1.ingest.sentry.io/42\n# agentdeck-removed: ORDERS_DSN [other url] — no ephemeral service container for this task\n',
    );
    expect(classifyEnv([{ name: 'SENTRY_DSN', value: 'https://k@sentry.io/1' }])).toEqual([]);
  });

  it('split connection vars: user, password and database follow the rewritten host', () => {
    const out = rewriteEnvText(
      'DB_HOST=prod-db\nDB_PORT=5432\nDB_USER=app\nDB_PASSWORD=prodpass\nDB_NAME=prod\nDB_POOL_SIZE=10\n',
      endpoints,
    );
    expect(out.text).toBe(
      'DB_HOST=127.0.0.1\nDB_PORT=54329\nDB_USER=test\nDB_PASSWORD=test\nDB_NAME=app\nDB_POOL_SIZE=10\n',
    );
    expect(out.text).not.toContain('prodpass');
  });

  it('an unreadable env file makes the whole answer unknown, nothing half-rewritten counts', async () => {
    const res = await rewriteEnv('/copy', endpoints, [''], {
      list: () => ({ value: ['.env', '.env.test'] }),
      read: async (p) =>
        p.endsWith('.env') ? { value: 'X=1\n' } : { unknown: 'EPERM: operation not permitted' },
      write: () => undefined,
    });
    expect(res).toEqual({ unknown: "env file '.env.test': EPERM: operation not permitted" });
    const dir = await rewriteEnv('/copy', endpoints, [''], {
      list: () => ({ unknown: 'EIO' }),
      read: async () => ({ absent: true }),
      write: () => undefined,
    });
    expect(dir).toEqual({ unknown: "env dir '.': EIO" });
  });
});
