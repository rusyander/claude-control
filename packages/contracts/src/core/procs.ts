import { z } from 'zod';
import type { Fact } from './facts.ts';

/**
 * Реестр процессов `<дом ядра>/procs.json` (00 §Processes, P83) и проверка личности ядра строки
 * перед отправкой ему bearer (F-19). Здесь, а не в ядре: панель (прокладка `/api/core/*`) и мосты
 * MCP ядра несут токен по адресу из этого файла, и проверка у них ОДНА — вторая копия у панели
 * однажды разошлась бы с ядром молча (core-s9 F10: прокладка верила любому адресу файла).
 * Модуль чистый: таблицу TCP и живость процесса даёт вызывающий (у ядра и у панели — свои чтения ОС).
 */

// Строки — `looseObject` (F-54): файл общий для сборок ядра, и поле, добавленное другой сборкой,
// не делает файл «мусором»; при переписи чужие поля сохраняются.
export const procEntrySchema = z.looseObject({
  build: z.string().min(1),
  pid: z.number().int().nonnegative(),
  pidStart: z.string().min(1),
  bootId: z.string().min(1),
  port: z.number().int().positive(),
  url: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  home: z.string().min(1),
  portDecision: z.looseObject({
    rejected: z.array(z.looseObject({ port: z.number().int().nonnegative(), reason: z.string() })),
  }),
  /**
   * Канал надзора этой загрузки (P131, pipe/unix socket): по нему сторож панели записывает звенья
   * пересылки. Нет — канал не открылся, звенья ядру записать нельзя (строгая команда через панель
   * — только с подписью устройства).
   */
  supervisor: z.string().min(1).optional(),
});
export type ProcEntry = z.infer<typeof procEntrySchema>;

/**
 * Серверы машины, которые запускает ядро (11 §Hop chain, §Local servers): хост звеньев, свой
 * сервер моделей, сервер-заглушка. Строка — для поиска и для уборки по pid + старту; доступа
 * (ключа, токена) здесь нет никогда.
 */
export const SERVER_KINDS = ['hop-host', 'model-server', 'stub-server'] as const;
export const serverEntrySchema = z.looseObject({
  kind: z.enum(SERVER_KINDS),
  id: z.string().min(1),
  pid: z.number().int().nonnegative(),
  pidStart: z.string().min(1),
  port: z.number().int().positive(),
  ownerBootId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
});
export type ServerEntry = z.infer<typeof serverEntrySchema>;

export const procsFileSchema = z.looseObject({
  v: z.literal(1),
  cores: z.array(procEntrySchema),
  servers: z.array(serverEntrySchema).default([]),
});
export type ProcsFile = z.infer<typeof procsFileSchema>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// `URL` есть во всех средах пакета (Node, браузер, телефон), но набор типов пакета — без DOM и
// без node: объявлено только то, что читает проверка адреса.
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
};

/**
 * Адрес строки годен для bearer (F-19): `http` на loopback, без учётных данных в адресе, и порт
 * адреса = порт строки. Иное (чужой хост, LAN, подменённый порт) — строка не ядро этой машины.
 */
export function isLoopbackCoreUrl(entry: Pick<ProcEntry, 'url' | 'port'>): boolean {
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(entry.url);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.username === '' &&
    url.password === '' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    Number(url.port) === entry.port
  );
}

/** Самая поздняя сборка среди строк на loopback (P83: выбор сборки — дело надзора). */
export function newestLoopbackCore(cores: readonly ProcEntry[]): ProcEntry | undefined {
  return cores.filter(isLoopbackCoreUrl).sort((a, b) => b.startedAt - a.startedAt)[0];
}

/** Строка таблицы TCP, которую читает проверка: кто слушает какой порт на каком адресе. */
export interface ListenRow {
  state: 'listen' | 'established' | 'other';
  localAddress: string;
  localPort: number;
  /** Владелец; `undefined` — ОС не сказала. */
  pid?: number;
}

export type CoreLiveness = 'alive' | 'dead' | 'unknown';

export interface CoreEntryCheckDeps {
  tcp(): Promise<Fact<ListenRow[]>>;
  /** Жив ли процесс с этим номером И этим стартом (`pidStart` строки — токен ОС ядра). */
  isAlive(id: { pid: number; start: string }): Promise<CoreLiveness>;
}

function normalizeAddress(address: string): string {
  const lower = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return lower.startsWith('::ffff:') && /^127\./.test(lower.slice(7)) ? lower.slice(7) : lower;
}

function isLoopbackAddress(address: string): boolean {
  const norm = normalizeAddress(address);
  return norm === '::1' || /^127\./.test(norm);
}

function isAnyAddress(address: string): boolean {
  return address === '0.0.0.0' || address === '::';
}

function factReason(fact: Fact<unknown>): string {
  if ('unknown' in fact) return fact.unknown;
  if ('absent' in fact) return 'absent';
  return 'value';
}

/**
 * Личность ядра строки перед отправкой ему bearer (F-19): порт строки на loopback слушает именно
 * pid строки, и этот pid жив с тем же стартом. Иначе — `unknown` с причиной, bearer не уходит.
 */
export async function verifyCoreEntry(
  entry: ProcEntry,
  deps: CoreEntryCheckDeps,
): Promise<Fact<true>> {
  if (!isLoopbackCoreUrl(entry)) return { unknown: `core url is not loopback: ${entry.url}` };
  const table = await deps.tcp();
  if (!('value' in table)) return { unknown: `tcp table: ${factReason(table)}` };
  const owners = new Set(
    table.value
      .filter(
        (row) =>
          row.state === 'listen' &&
          row.localPort === entry.port &&
          (isLoopbackAddress(row.localAddress) || isAnyAddress(row.localAddress)),
      )
      .map((row) => row.pid),
  );
  if (owners.size === 0) return { unknown: `nobody listens on ${entry.port}` };
  if (owners.size > 1 || !owners.has(entry.pid))
    return {
      unknown: `port ${entry.port} listener is pid ${[...owners].join(', ')}, not ${entry.pid}`,
    };
  const live = await deps.isAlive({ pid: entry.pid, start: entry.pidStart });
  if (live !== 'alive') return { unknown: `core pid ${entry.pid} is ${live}` };
  return { value: true };
}
