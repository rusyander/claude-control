import type { ComposeDbService, DbTarget } from '../database.types.ts';

/**
 * База в Compose: сервис на образе Postgres. Реквизиты — из его же
 * `environment` (так их задаёт официальный образ и образ Bitnami), адрес —
 * опубликованный наружу порт.
 */

/** Образы, в которых живёт Postgres: официальный, PostGIS, Timescale, pgvector, Bitnami, Supabase. */
const POSTGRES_IMAGE = /(^|\/)(postgres|postgresql|postgis|timescaledb[\w-]*|pgvector)(:|@|$)/i;

/** Образы баз, которые панель видит, но пока не читает. */
const OTHER_IMAGES: [RegExp, string][] = [
  [/(^|\/)mysql(:|@|$)/i, 'mysql'],
  [/(^|\/)mariadb(:|@|$)/i, 'mariadb'],
  [/(^|\/)mongo(db)?(:|@|$)/i, 'mongodb'],
  [/(^|\/)(mssql\/server|azure-sql-edge)(:|@|$)/i, 'sqlserver'],
  [/(^|\/)clickhouse(-server)?(:|@|$)/i, 'clickhouse'],
  [/(^|\/)cockroach(:|@|$)/i, 'cockroachdb'],
];

export type ComposeDbVerdict =
  | { kind: 'postgres'; target: DbTarget }
  | { kind: 'other'; engine: string }
  | { kind: 'no-port' }
  | undefined;

/** Движок по образу: `docker.io/library/postgres:18` → `postgres`; реестр и тег регэксп терпит. */
export function engineOfImage(image: string | undefined): string | undefined {
  if (!image) return undefined;
  if (POSTGRES_IMAGE.test(image)) return 'postgres';
  return OTHER_IMAGES.find(([pattern]) => pattern.test(image))?.[1];
}

export function readComposeService(service: ComposeDbService): ComposeDbVerdict {
  const engine = engineOfImage(service.image);
  if (!engine) return undefined;
  if (engine !== 'postgres') return { kind: 'other', engine };

  const env = service.environment;
  const inner = Number(env.PGPORT) || 5432;
  const port = service.ports.find((item) => item.target === inner && item.protocol === 'tcp');
  if (!port) return { kind: 'no-port' };

  const user = env.POSTGRES_USER || env.POSTGRESQL_USERNAME || 'postgres';
  const target: DbTarget = {
    // Опубликован на всех адресах (`0.0.0.0`) или на конкретном — с этой машины
    // ходим через петлю, кроме случая, когда порт привязан к другому адресу.
    host: port.host && port.host !== '0.0.0.0' && port.host !== '::' ? port.host : '127.0.0.1',
    port: port.published,
    database: env.POSTGRES_DB || env.POSTGRESQL_DATABASE || user,
    user,
  };
  const password = env.POSTGRES_PASSWORD || env.POSTGRESQL_PASSWORD;
  if (password) target.password = password;
  return { kind: 'postgres', target };
}
