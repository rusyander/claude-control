import type { DbTarget, ParsedTarget } from '../database.types.ts';
import { parseDatabaseUrl } from './url.ts';

/**
 * Базы, названные переменными окружения: файлы `.env*` проекта и `environment`
 * сервиса Compose. Три принятых способа: один адрес (`DATABASE_URL`), набор
 * libpq (`PGHOST`, `PGDATABASE`…) и набор фреймворка (`DB_HOST`, `DB_NAME`…).
 */

export interface EnvFinding {
  /** Чем названа: имя переменной адреса или префикс набора (`PG*`, `DB_*`). */
  key: string;
  parsed: ParsedTarget;
}

/** Переменная с адресом базы: `DATABASE_URL`, `READ_DATABASE_URL`, `POSTGRES_DSN`… */
const URL_KEY =
  /^(?:[A-Z0-9_]*_)?(?:DATABASE|DB|POSTGRES|POSTGRESQL|PG)_(?:URL|URI|DSN)$|^DATABASE_URL$/;

/** Набор переменных, по префиксу. Порядок имён — по убыванию распространённости. */
const SETS: {
  label: string;
  host: string[];
  port: string[];
  db: string[];
  user: string[];
  password: string[];
  engine?: string[];
}[] = [
  {
    label: 'PG*',
    host: ['PGHOST'],
    port: ['PGPORT'],
    db: ['PGDATABASE'],
    user: ['PGUSER'],
    password: ['PGPASSWORD'],
  },
  {
    label: 'POSTGRES_*',
    host: ['POSTGRES_HOST'],
    port: ['POSTGRES_PORT'],
    db: ['POSTGRES_DB', 'POSTGRES_DATABASE'],
    user: ['POSTGRES_USER'],
    password: ['POSTGRES_PASSWORD'],
  },
  {
    label: 'DB_*',
    host: ['DB_HOST', 'DATABASE_HOST'],
    port: ['DB_PORT', 'DATABASE_PORT'],
    db: ['DB_NAME', 'DB_DATABASE', 'DATABASE_NAME'],
    user: ['DB_USER', 'DB_USERNAME', 'DATABASE_USER', 'DATABASE_USERNAME'],
    password: ['DB_PASSWORD', 'DB_PASS', 'DATABASE_PASSWORD'],
    engine: ['DB_CONNECTION', 'DB_DRIVER', 'DB_ENGINE', 'DB_TYPE', 'DB_DIALECT'],
  },
];

const first = (vars: Record<string, string>, keys: string[]): string | undefined =>
  keys.map((key) => vars[key]?.trim()).find((value) => value && !value.includes('${'));

/** Движок из `DB_CONNECTION=mysql`, `DB_ENGINE=django.db.backends.postgresql`. */
function engineFromHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const lower = hint.toLowerCase();
  if (lower.includes('postgres') || lower === 'pgsql' || lower === 'pg') return 'postgres';
  if (lower.includes('mysql')) return 'mysql';
  if (lower.includes('maria')) return 'mariadb';
  if (lower.includes('sqlite')) return 'sqlite';
  if (lower.includes('mssql') || lower.includes('sqlserver')) return 'sqlserver';
  if (lower.includes('mongo')) return 'mongodb';
  return lower;
}

/**
 * Найти базы в наборе переменных. Набор без хоста не считается: `POSTGRES_USER`
 * без `POSTGRES_HOST` — это настройка самого контейнера Postgres, а не адрес,
 * и её разбирает источник Compose.
 */
export function findInEnv(vars: Record<string, string>): EnvFinding[] {
  const found: EnvFinding[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (!URL_KEY.test(key)) continue;
    const parsed = parseDatabaseUrl(value);
    if (parsed) found.push({ key, parsed });
  }
  for (const set of SETS) {
    const host = first(vars, set.host);
    if (!host) continue;
    const engine = engineFromHint(set.engine ? first(vars, set.engine) : undefined) ?? 'postgres';
    if (engine !== 'postgres') {
      found.push({ key: set.label, parsed: { kind: 'other', engine } });
      continue;
    }
    const user = first(vars, set.user) ?? 'postgres';
    const target: DbTarget = {
      host,
      port: Number(first(vars, set.port)) || 5432,
      database: first(vars, set.db) ?? user,
      user,
    };
    const password = first(vars, set.password);
    if (password) target.password = password;
    found.push({ key: set.label, parsed: { kind: 'postgres', target } });
  }
  return found;
}
