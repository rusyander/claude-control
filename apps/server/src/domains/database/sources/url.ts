import type { DbTarget, ParsedTarget } from '../database.types.ts';

/**
 * Адреса баз в том виде, в каком их пишут проекты: URL драйвера
 * (`postgres://`, `postgresql+asyncpg://`, `jdbc:postgresql://`,
 * `r2dbc:postgresql://`) и строка ключей libpq (`host=… dbname=…`).
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** Адрес на этой машине. Всё остальное окно помечает как «не локальная база». */
export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return LOOPBACK.has(lower) || lower.startsWith('127.');
}

/** Схема URL → движок. `postgresql+psycopg` и `jdbc:postgresql` — тот же Postgres. */
function engineOf(scheme: string): string {
  const base =
    scheme
      .toLowerCase()
      .replace(/^(jdbc|r2dbc):/, '')
      .split('+')[0] ?? '';
  if (base === 'postgres' || base === 'postgresql' || base === 'pgsql') return 'postgres';
  if (base === 'mysql' || base === 'mariadb') return base;
  if (base.startsWith('mongodb')) return 'mongodb';
  if (base === 'sqlserver' || base === 'mssql') return 'sqlserver';
  if (base === 'sqlite' || base === 'sqlite3') return 'sqlite';
  if (base === 'clickhouse') return 'clickhouse';
  if (base === 'oracle') return 'oracle';
  return base;
}

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Разобрать адрес базы. `undefined` — это не адрес базы вовсе (пустая строка,
 * `redis://`, подстановка `${…}`, которую раскрыть нечем).
 */
export function parseDatabaseUrl(raw: string): ParsedTarget | undefined {
  const value = raw.trim();
  if (!value || value.includes('${')) return undefined;
  if (!value.includes('://')) return parseKeyValueDsn(value);

  const match = /^([a-z][a-z0-9+.:-]*):\/\/(.*)$/i.exec(value);
  if (!match) return undefined;
  const engine = engineOf(match[1] ?? '');
  if (
    engine === 'redis' ||
    engine === 'rediss' ||
    engine === 'amqp' ||
    engine === 'http' ||
    engine === 'https'
  ) {
    return undefined;
  }
  if (engine !== 'postgres') return { kind: 'other', engine };

  // JDBC пишет учётку параметрами (`?user=…&password=…`), а не в адресе.
  let url: URL;
  try {
    url = new URL(`postgres://${match[2] ?? ''}`);
  } catch {
    return undefined;
  }
  const params = url.searchParams;
  const host = decode(url.hostname.replace(/^\[|\]$/g, '')) || params.get('host') || 'localhost';
  const target: DbTarget = {
    host,
    port: Number(url.port) || Number(params.get('port')) || 5432,
    database: decode(url.pathname.replace(/^\//, '')) || params.get('dbname') || '',
    user: decode(url.username) || params.get('user') || '',
  };
  const password = url.password ? decode(url.password) : params.get('password');
  if (password) target.password = password;
  if (!target.database) target.database = target.user || 'postgres';
  if (!target.user) target.user = 'postgres';
  return { kind: 'postgres', target };
}

/** Строка ключей libpq: `host=localhost port=5432 dbname=app user=app password='a b'`. */
export function parseKeyValueDsn(value: string): ParsedTarget | undefined {
  const pairs = new Map<string, string>();
  for (const match of value.matchAll(/(\w+)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|(\S+))/g)) {
    pairs.set((match[1] ?? '').toLowerCase(), (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'));
  }
  if (!pairs.has('host') && !pairs.has('dbname')) return undefined;
  const target: DbTarget = {
    host: pairs.get('host') || 'localhost',
    port: Number(pairs.get('port')) || 5432,
    database: pairs.get('dbname') || pairs.get('user') || 'postgres',
    user: pairs.get('user') || 'postgres',
  };
  const password = pairs.get('password');
  if (password) target.password = password;
  return { kind: 'postgres', target };
}
