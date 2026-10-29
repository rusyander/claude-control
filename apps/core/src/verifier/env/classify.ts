import type { ServiceVar } from '@agentdeck/contracts/core/records';

/**
 * Переменные подключения к сервисам (04:92-94): класс — по имени (`DATABASE_URL`, `*_DSN`,
 * `*_DB_*`, `REDIS_URL`, `AMQP_*`, `KAFKA_*`, …) и по схеме URL (`postgres://`, `mysql://`,
 * `mongodb://`, `redis://`, `amqp://`, …). Значение читается только здесь и только ради схемы и
 * хоста — наружу уходит класс, никогда значение (04:91). Хост, который не доказан как
 * эфемерный ресурс задачи, — не эфемерный: без значения доказать нечего, значит `remote`
 * (никогда не зеркалится, 04:94).
 */

export type Scheme = ServiceVar['scheme'];

export interface EnvSample {
  name: string;
  value?: string;
}

export interface EphemeralHost {
  host: string;
  port: number;
}

const SCHEME_BY_PROTOCOL: Record<string, Scheme> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
  redis: 'redis',
  rediss: 'redis',
  amqp: 'amqp',
  amqps: 'amqp',
  kafka: 'kafka',
};

/** Файл, а не сервис: `sqlite:///db.sqlite3` подключением к хосту не бывает. */
const FILE_PROTOCOLS = new Set(['sqlite', 'sqlite3', 'file']);

/** Веб-адрес, а не сервис задачи: `SENTRY_DSN=https://…` к контейнеру БД не переписывается. */
const WEB_PROTOCOLS = new Set(['http', 'https', 'ws', 'wss']);

const NAME_FAMILIES: [RegExp, Scheme][] = [
  [/^(POSTGRES|POSTGRESQL|PG)(_|HOST|PORT|USER|PASSWORD|DATABASE|$)/, 'postgres'],
  [/^(MYSQL|MARIADB)(_|$)/, 'mysql'],
  [/^MONGO(DB)?(_|$)/, 'mongodb'],
  [/^REDIS(_|$)/, 'redis'],
  [/^(AMQP|RABBITMQ|RABBIT)(_|$)/, 'amqp'],
  [/^KAFKA(_|$)/, 'kafka'],
];

/** Имя, которое само говорит «подключение к сервису» (04:92). */
const SERVICE_NAME = [
  /^DATABASE_URL$/,
  /_DATABASE_URL$/,
  /^DB_/,
  /_DB_/,
  /_DB$/,
  /_DSN$/,
  /^DSN$/,
  /^(CELERY_)?BROKER_URL$/,
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export function protocolOf(value: string): string | undefined {
  const m = /^(?:jdbc:)?([a-z][a-z0-9+.-]*):\/\//i.exec(value.trim());
  return m ? (m[1] as string).toLowerCase() : undefined;
}

export function schemeOfValue(value: string | undefined): Scheme | undefined {
  if (value === undefined) return undefined;
  const p = protocolOf(value);
  return p ? SCHEME_BY_PROTOCOL[p] : undefined;
}

export function schemeOfName(name: string): Scheme | undefined {
  const upper = name.toUpperCase();
  for (const [re, scheme] of NAME_FAMILIES) if (re.test(upper)) return scheme;
  return undefined;
}

function serviceByName(name: string): boolean {
  const upper = name.toUpperCase();
  return schemeOfName(upper) !== undefined || SERVICE_NAME.some((re) => re.test(upper));
}

export function isHostVar(name: string): boolean {
  return /(_HOST|_HOSTNAME|^PGHOST)$/i.test(name) || /^PGHOST$/i.test(name);
}

export function isPortVar(name: string): boolean {
  return /(_PORT|^PGPORT)$/i.test(name) || /^PGPORT$/i.test(name);
}

/** Хост и порт из URL-значения или из самого значения переменной `*_HOST`. */
export function hostOf(
  name: string,
  value: string | undefined,
): { host: string; port?: number } | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (isHostVar(name) && !v.includes('://')) return { host: v.toLowerCase() };
  const m = /^(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?,]+)(?::(\d+))?/i.exec(
    v,
  );
  if (!m) return undefined;
  return { host: (m[1] as string).toLowerCase(), ...(m[2] ? { port: Number(m[2]) } : {}) };
}

function hostKind(
  name: string,
  value: string | undefined,
  ephemeral: readonly EphemeralHost[],
): ServiceVar['hostKind'] {
  const at = hostOf(name, value);
  if (!at) return 'remote';
  if (!LOCAL_HOSTS.has(at.host)) return 'remote';
  if (at.port !== undefined && ephemeral.some((e) => LOCAL_HOSTS.has(e.host) && e.port === at.port))
    return 'ephemeral';
  return 'local-non-ephemeral';
}

/**
 * Классы сервисных переменных выборки. Не сервис — не в ответе. `ephemeral` — адреса ресурсов
 * задачи (контейнеры зоны сервисов): только совпадение хоста-loopback и порта с ними делает
 * значение эфемерным.
 */
export function classifyEnv(
  sample: readonly EnvSample[],
  ephemeral: readonly EphemeralHost[] = [],
): ServiceVar[] {
  const out: ServiceVar[] = [];
  for (const { name, value } of sample) {
    const protocol = value !== undefined ? protocolOf(value) : undefined;
    if (protocol && (FILE_PROTOCOLS.has(protocol) || WEB_PROTOCOLS.has(protocol))) continue;
    const byValue = schemeOfValue(value);
    const byName = serviceByName(name);
    if (!byName && !byValue) continue;
    out.push({
      name,
      scheme: byValue ?? schemeOfName(name) ?? 'other',
      hostKind: hostKind(name, value, ephemeral),
      source: byName ? 'name' : 'scheme',
    });
  }
  return out;
}

/** Строки `ИМЯ=значение` файла окружения; `export` впереди и кавычки значения сняты. */
export function parseEnvText(text: string): { name: string; value: string; line: number }[] {
  const out: { name: string; value: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) return;
    let value = (m[2] as string).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.push({ name: m[1] as string, value, line });
  });
  return out;
}
