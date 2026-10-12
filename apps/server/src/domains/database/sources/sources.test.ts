import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readComposeService } from './compose.ts';
import { findInEnv } from './env.ts';
import { findConnections } from './sources.ts';
import { findInSpring, readProperties, readYamlProperties, resolvePlaceholders } from './spring.ts';
import { isLoopbackHost, parseDatabaseUrl } from './url.ts';

describe('parseDatabaseUrl', () => {
  it('разбирает адреса драйверов Postgres', () => {
    expect(parseDatabaseUrl('postgres://app:s%40cret@localhost:5433/shop?sslmode=disable')).toEqual(
      {
        kind: 'postgres',
        target: {
          host: 'localhost',
          port: 5433,
          database: 'shop',
          user: 'app',
          password: 's@cret',
        },
      },
    );
    expect(parseDatabaseUrl('postgresql+asyncpg://u:p@db/main')).toMatchObject({
      target: { host: 'db', port: 5432, database: 'main', user: 'u' },
    });
    expect(parseDatabaseUrl('jdbc:postgresql://10.0.0.5:6432/billing?user=ro&password=x')).toEqual({
      kind: 'postgres',
      target: { host: '10.0.0.5', port: 6432, database: 'billing', user: 'ro', password: 'x' },
    });
    expect(parseDatabaseUrl("host=localhost port=5434 dbname=app user=me password='a b'")).toEqual({
      kind: 'postgres',
      target: { host: 'localhost', port: 5434, database: 'app', user: 'me', password: 'a b' },
    });
  });

  it('называет чужой движок и молчит о том, что не база', () => {
    expect(parseDatabaseUrl('mysql://root@localhost/app')).toEqual({
      kind: 'other',
      engine: 'mysql',
    });
    expect(parseDatabaseUrl('mongodb+srv://x@cluster/db')).toEqual({
      kind: 'other',
      engine: 'mongodb',
    });
    expect(parseDatabaseUrl('redis://localhost:6379')).toBeUndefined();
    expect(parseDatabaseUrl('postgres://${DB_HOST}/app')).toBeUndefined();
    expect(parseDatabaseUrl('')).toBeUndefined();
  });

  it('петля — только адреса этой машины', () => {
    expect(['localhost', '127.0.0.1', '127.1.2.3', '::1', '0.0.0.0'].every(isLoopbackHost)).toBe(
      true,
    );
    expect(isLoopbackHost('db.prod.internal')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });
});

describe('findInEnv', () => {
  it('находит адрес и наборы переменных', () => {
    const found = findInEnv({
      DATABASE_URL: 'postgres://a:b@localhost/one',
      READ_DATABASE_URL: 'postgres://ro@replica.example.com/one',
      PGHOST: 'localhost',
      PGDATABASE: 'two',
      PGUSER: 'pguser',
      DB_HOST: 'localhost',
      DB_CONNECTION: 'mysql',
      REDIS_URL: 'redis://localhost',
    });
    expect(found.map((item) => [item.key, item.parsed.kind])).toEqual([
      ['DATABASE_URL', 'postgres'],
      ['READ_DATABASE_URL', 'postgres'],
      ['PG*', 'postgres'],
      ['DB_*', 'other'],
    ]);
  });

  it('POSTGRES_USER без хоста — настройка контейнера, не адрес', () => {
    expect(findInEnv({ POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p' })).toEqual([]);
  });
});

describe('Spring', () => {
  it('читает properties и YAML и раскрывает подстановки', () => {
    const props = readProperties(
      'spring.datasource.url=jdbc:postgresql://${DB_HOST:localhost}:5432/app\nspring.datasource.username=${DB_USER}\nspring.datasource.password = secret',
    );
    expect(findInSpring(props, { DB_USER: 'svc' })).toEqual({
      kind: 'postgres',
      target: { host: 'localhost', port: 5432, database: 'app', user: 'svc', password: 'secret' },
    });
    const yaml = readYamlProperties(
      'spring:\n  r2dbc:\n    url: r2dbc:postgresql://localhost:5440/rx\n    username: rx\n---\nserver:\n  port: 8080\n',
    );
    expect(findInSpring(yaml, {})).toMatchObject({
      target: { port: 5440, database: 'rx', user: 'rx' },
    });
  });

  it('нераскрываемая подстановка — не адрес', () => {
    expect(resolvePlaceholders('${NOPE}', {})).toBeUndefined();
    expect(
      findInSpring({ 'spring.datasource.url': 'jdbc:postgresql://${NOPE}/x' }, {}),
    ).toBeUndefined();
  });
});

describe('readComposeService', () => {
  const service = (
    image: string,
    ports = [{ host: '', published: 55432, target: 5432, protocol: 'tcp' }],
  ) => ({
    name: 'db',
    image,
    ports,
    environment: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw' },
  });

  it('Postgres с опубликованным портом — подключение через петлю', () => {
    expect(readComposeService(service('postgres:18.1-bookworm'))).toEqual({
      kind: 'postgres',
      target: { host: '127.0.0.1', port: 55432, database: 'app', user: 'app', password: 'pw' },
    });
    expect(readComposeService(service('postgis/postgis:16-3.4'))?.kind).toBe('postgres');
  });

  it('без порта и чужой движок называются, но не подключаются', () => {
    expect(readComposeService(service('postgres:18', []))).toEqual({ kind: 'no-port' });
    expect(readComposeService(service('mysql:8'))).toEqual({ kind: 'other', engine: 'mysql' });
    expect(readComposeService(service('redis:7'))).toBeUndefined();
  });
});

describe('findConnections', () => {
  let root: string;
  const put = (path: string, text: string): void => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'db-sources-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('сводит одну базу из compose, .env и Spring в одну строку и знает пароль', () => {
    // В .env приложения в контейнере база называется по имени сервиса.
    put('.env', 'DATABASE_URL=postgres://app@db:5432/app\n');
    put(
      'backend/src/main/resources/application.properties',
      'spring.datasource.url=jdbc:postgresql://localhost:55432/app\nspring.datasource.username=app\n',
    );
    put('backend/.env.example', 'DATABASE_URL=mysql://root@localhost/legacy\n');
    const { connections, unsupported } = findConnections(root, {
      file: 'compose.yaml',
      services: [
        {
          name: 'db',
          image: 'postgres:18',
          ports: [{ host: '', published: 55432, target: 5432, protocol: 'tcp' }],
          environment: { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw' },
          state: 'running',
        },
        {
          name: 'cache',
          image: 'mariadb:11',
          ports: [],
          environment: {},
        },
      ],
    });
    expect(connections).toHaveLength(1);
    expect(connections[0]?.info).toMatchObject({
      id: 'compose:db',
      host: '127.0.0.1',
      port: 55432,
      hasPassword: true,
      remote: false,
      composeState: 'running',
    });
    expect(connections[0]?.password).toBe('pw');
    expect(unsupported).toEqual([
      { origin: 'compose.yaml → cache', engine: 'mariadb', reason: 'engine' },
      { origin: 'backend/.env.example → DATABASE_URL', engine: 'mysql', reason: 'engine' },
    ]);
  });

  it('шаблон .env.example не читается, когда рядом настоящий .env', () => {
    put('.env', 'DATABASE_URL=postgres://a@localhost/real\n');
    put('.env.example', 'DATABASE_URL=postgres://a@localhost/template\n');
    const { connections } = findConnections(root, undefined);
    expect(connections.map((item) => item.info.database)).toEqual(['real']);
  });

  it('удалённая база помечена, пароля в описании нет', () => {
    put('.env.local', 'DATABASE_URL=postgres://ro:secret@db.prod.example.com:5432/main\n');
    const { connections } = findConnections(root, undefined);
    expect(connections[0]?.info).toMatchObject({ remote: true, hasPassword: true, source: 'env' });
    expect(JSON.stringify(connections[0]?.info)).not.toContain('secret');
  });
});
