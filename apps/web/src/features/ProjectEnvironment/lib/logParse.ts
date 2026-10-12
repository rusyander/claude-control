/**
 * Строка лога для вкладки «Логи»: уровень и, если строка — JSON, сообщение и
 * поля. Распознаём то, что пишут распространённые логгеры: zap, logrus, slog,
 * pino, structlog, Spring, Python logging, nginx; остальное — без уровня.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export interface ParsedLog {
  level?: LogLevel;
  /** Сообщение: у JSON — поле msg/message, у прочих — сама строка. */
  message: string;
  /** Остальные поля JSON-строки, по порядку. */
  fields?: [string, string][];
  /** Строка — продолжение предыдущей (стек вызовов): уровень от неё. */
  continuation?: boolean;
}

const LEVEL_NAMES: Record<string, LogLevel> = {
  fatal: 'error',
  panic: 'error',
  critical: 'error',
  crit: 'error',
  error: 'error',
  err: 'error',
  severe: 'error',
  alert: 'error',
  emerg: 'error',
  warning: 'warn',
  warn: 'warn',
  info: 'info',
  notice: 'info',
  information: 'info',
  debug: 'debug',
  trace: 'debug',
  verbose: 'debug',
  fine: 'debug',
};

/** pino и bunyan пишут уровень числом. */
const numericLevel = (value: number): LogLevel => {
  if (value >= 50) return 'error';
  if (value >= 40) return 'warn';
  if (value >= 30) return 'info';
  return 'debug';
};

const levelOf = (value: unknown): LogLevel | undefined => {
  if (typeof value === 'number') return numericLevel(value);
  if (typeof value !== 'string') return undefined;
  return LEVEL_NAMES[value.trim().toLowerCase()];
};

const LEVEL_KEYS = ['level', 'severity', 'lvl', 'loglevel', 'log.level', 'levelname'];
const MESSAGE_KEYS = ['msg', 'message', 'event', 'text'];
const SKIP_KEYS = new Set([
  ...LEVEL_KEYS,
  ...MESSAGE_KEYS,
  'time',
  'ts',
  'timestamp',
  '@timestamp',
]);

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

function parseJson(text: string): ParsedLog | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const levelKey = LEVEL_KEYS.find((key) => key in record);
  const messageKey = MESSAGE_KEYS.find((key) => typeof record[key] === 'string');
  const level = levelKey ? levelOf(record[levelKey]) : undefined;
  return {
    ...(level ? { level } : {}),
    message: messageKey ? String(record[messageKey]) : trimmed,
    fields: Object.entries(record)
      .filter(([key]) => !SKIP_KEYS.has(key))
      .map(([key, item]): [string, string] => [key, asText(item)]),
  };
}

/** `level=error`, `[ERROR]`, ` ERROR 1234 --- ` (Spring), `ERROR:root:` (Python), `[error]` (nginx). */
const KEY_VALUE = /\b(?:level|lvl|severity)=["']?([a-z]+)/i;
const BRACKETED =
  /[[(<]\s*(fatal|panic|critical|crit|error|err|warn|warning|info|notice|debug|trace)\s*[\])>]/i;
const BARE_UPPER =
  /(?:^|[\s|:])(FATAL|PANIC|CRITICAL|ERROR|WARN|WARNING|INFO|NOTICE|DEBUG|TRACE)(?=[\s:|\]]|$)/;
const PREFIX_LOWER = /^(panic|fatal|error|warning):\s/;
const CONTINUATION =
  /^(\s+\S|\s*at\s|Caused by:|\.\.\. \d+ more|Traceback \(most recent call last\):|goroutine \d+ \[)/;
const ERROR_HINT = /^(Traceback \(most recent call last\):|(?:\w+\.)*\w*(Exception|Error)(?::|$))/;

function plainLevel(text: string): LogLevel | undefined {
  const found =
    KEY_VALUE.exec(text)?.[1] ??
    BRACKETED.exec(text)?.[1] ??
    BARE_UPPER.exec(text)?.[1] ??
    PREFIX_LOWER.exec(text)?.[1];
  if (found) return LEVEL_NAMES[found.toLowerCase()];
  return ERROR_HINT.test(text.trim()) ? 'error' : undefined;
}

/** Разбор одной строки; `previous` — уровень строки выше, для стека вызовов. */
export function parseLogLine(text: string, previous?: LogLevel): ParsedLog {
  const json = parseJson(text);
  if (json) return json;
  if (CONTINUATION.test(text) && previous) {
    return { level: previous, message: text, continuation: true };
  }
  const level = plainLevel(text);
  return { ...(level ? { level } : {}), message: text };
}

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Проходит ли строка порог «уровень и важнее»; без порога — все, с порогом строки без уровня скрыты. */
export const passesLevel = (level: LogLevel | undefined, threshold?: LogLevel): boolean =>
  !threshold || (level !== undefined && RANK[level] <= RANK[threshold]);
