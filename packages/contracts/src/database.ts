/**
 * База данных проекта — вкладка «База данных» окна «Окружение» и те же
 * инструменты агенту через MCP панели. Только чтение: схема, запрос, EXPLAIN и
 * состояние миграций. Панель не пишет в базу ничего и миграций не применяет.
 */

import type { ComposeServiceState } from './compose';

/** Движок. Пока один: Postgres; найденные MySQL и прочие называются, но не подключаются. */
export type DbEngine = 'postgres';

/** Откуда панель взяла подключение. */
export type DbConnectionSource = 'compose' | 'env' | 'spring' | 'manual';

export interface DbConnection {
  /** Устойчивый id: `compose:db`, `env:.env:DATABASE_URL`, `manual:<uuid>`. */
  id: string;
  source: DbConnectionSource;
  engine: DbEngine;
  /** Подпись для человека: имя сервиса, переменной или своё. */
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
  /** Пароль известен панели. Сам пароль наружу не выходит никогда. */
  hasPassword: boolean;
  /** Где лежат реквизиты: «docker/compose.yaml → db», «.env → DATABASE_URL». */
  origin: string;
  /** Адрес не на этой машине — окно предупреждает: это может быть общая или боевая база. */
  remote: boolean;
  /** Сервис Compose, за которым стоит база, и его состояние — не работает, значит, и подключаться не к чему. */
  composeService?: string;
  composeState?: ComposeServiceState;
}

/**
 * База нашлась, но подключиться панель не может: движок она пока не читает
 * (MySQL в compose, `mysql://` в `.env`) или Postgres в compose не опубликовал
 * порт наружу.
 */
export interface DbUnsupported {
  origin: string;
  engine: string;
  reason: 'engine' | 'no-port';
}

export interface DbConnectionsInfo {
  projectPath: string;
  connections: DbConnection[];
  unsupported: DbUnsupported[];
  /** Переходник MCP панели для базы записан в конфигурацию активного CLI. */
  mcpRegistered: boolean;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
}

export interface DbTable {
  schema: string;
  name: string;
  kind: 'table' | 'view' | 'materialized-view' | 'partitioned-table' | 'foreign-table';
  /** Оценка числа строк из статистики (`reltuples`); -1 — статистики нет. */
  rowsEstimate: number;
  columns: DbColumn[];
  primaryKey: string[];
}

export interface DbSchema {
  connectionId: string;
  serverVersion: string;
  tables: DbTable[];
  /** Таблиц больше, чем панель показывает за раз. */
  truncated: boolean;
}

export type DbQueryMode = 'run' | 'explain' | 'explain-analyze';

export interface DbQueryColumn {
  name: string;
  /** Тип Postgres: `int4`, `text`, `timestamptz`… */
  type: string;
}

export interface DbQueryResult {
  mode: DbQueryMode;
  columns: DbQueryColumn[];
  /** Значения строками: `null` — NULL; даты в ISO, байты в `\x…`, JSON как текст. */
  rows: (string | null)[][];
  /** Строк было больше лимита — показаны первые. */
  truncated: boolean;
  durationMs: number;
  /** План EXPLAIN текстом — у `explain` и `explain-analyze`. */
  plan?: string;
}

/** Инструмент миграций, которым пользуется проект. */
export type MigrationTool =
  | 'golang-migrate'
  | 'goose'
  | 'flyway'
  | 'alembic'
  | 'django'
  | 'prisma'
  | 'knex'
  | 'sqlx'
  | 'dbmate'
  | 'rails';

export interface MigrationsInfo {
  tool?: MigrationTool;
  /** Каталог миграций относительно корня проекта. */
  dir?: string;
  /** Таблица учёта в базе: `schema_migrations`, `alembic_version`… */
  table?: string;
  /** Миграции из каталога в порядке применения. */
  migrations: { id: string; applied: boolean }[];
  /** Записаны в базе, но файла в проекте нет — ветку переключили или файл удалили. */
  orphaned: string[];
  /** golang-migrate: прошлая миграция упала посередине (`dirty`). */
  dirty?: boolean;
  /** Таблицы учёта ещё нет — миграции не запускались ни разу. */
  neverRun?: boolean;
  /** Почему состояние не прочитано: база недоступна, нет прав на таблицу учёта. */
  error?: string;
}
