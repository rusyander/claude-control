import { z } from 'zod';
import {
  acquireExclusive,
  releaseExclusive,
  type LockDeps,
  type LockHolder,
} from './exclusive-lock.ts';
import { factReason, hasValue, type Fact } from './os-kind.ts';
import { normalizeAddress } from './peer-pid.ts';
import type { Liveness } from './process-identity.ts';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { readBytesSync } from './safe-io/files.ts';
import type { TcpEntry } from './tcp-table.ts';

/**
 * Реестр процессов `<core home>/procs.json` (00 §Processes, P83): где слушает каждая сборка
 * ядра. Панель, прокладки и MCP-сервер находят ядро здесь (или в `AGENTDECK_CORE_URL` сессии).
 *
 * По 00 файлом владеет супервизор; во второй фазе супервизора ещё нет, поэтому ядро пишет свою
 * строку само — атомарной заменой под замком `procs.json.lock` с той же дисциплиной перехвата,
 * что у аренды (дельта спецификации в отчёте). Две сборки, стартовавшие разом, не теряют строк
 * друг друга: чтение-правка-запись идёт только под замком.
 */

// Строки — `looseObject` (F-54): файл общий для сборок ядра, и поле, добавленное другой сборкой,
// не делает файл «мусором» (findCore → unknown, registerCore → отказ загрузки); при переписи
// чужие поля сохраняются.
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

/** Замок молчит дольше — держатель считается брошенным (если и мёртв). */
export const LOCK_SILENT_MS = 10_000;
/**
 * Ожидание замка — порог молчания плюс запас (F-29): ядро, убитое с замком и поднятое
 * автозапуском через секунды, иначе сдавалось раньше, чем брошенный замок становился
 * перехватываемым, — и падало в цикле перезапусков. Обе величины — от одной константы.
 */
export const LOCK_WAIT_MS = LOCK_SILENT_MS + 5_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Адрес строки годен для bearer сессии (F-19, половина платформы): `http` на loopback, без
 * учётных данных в адресе, и порт адреса = порт строки. Иное (чужой хост, LAN, подменённый
 * порт) — строка не ядро этой машины, читатель её не видит.
 */
export function isLoopbackCoreUrl(entry: Pick<ProcEntry, 'url' | 'port'>): boolean {
  let url: URL;
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

export function readProcs(
  path: string,
): { value: ProcsFile } | { absent: true } | { unknown: string } {
  const bytes = readBytesSync(path);
  if (!('value' in bytes)) return bytes;
  const parsed = procsFileSchema.safeParse(safeJson(bytes.value.toString('utf8')));
  if (!parsed.success) return { unknown: 'garbage: procs.json failed schema' };
  // Строка с адресом не на loopback не отдаётся ни одному читателю и уходит при следующей переписи.
  return { value: { ...parsed.data, cores: parsed.data.cores.filter(isLoopbackCoreUrl) } };
}

export interface CoreEntryCheckDeps {
  tcp(): Promise<Fact<TcpEntry[]>>;
  isAlive(id: { pid: number; start: string }): Promise<Liveness>;
}

/**
 * Личность ядра строки перед отправкой ему bearer (F-19): порт строки на loopback слушает
 * именно pid строки, и этот pid жив с тем же стартом. Иначе — `unknown` с причиной, bearer не
 * уходит. Вызывает читатель (мост MCP) — здесь только проверка.
 */
export async function verifyCoreEntry(
  entry: ProcEntry,
  deps: CoreEntryCheckDeps,
): Promise<Fact<true>> {
  if (!isLoopbackCoreUrl(entry)) return { unknown: `core url is not loopback: ${entry.url}` };
  const table = await deps.tcp();
  if (!hasValue(table)) return { unknown: `tcp table: ${factReason(table)}` };
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

function isAnyAddress(address: string): boolean {
  return address === '0.0.0.0' || address === '::';
}

function isLoopbackAddress(address: string): boolean {
  const norm = normalizeAddress(address);
  return norm === '::1' || /^127\./.test(norm);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface ProcsDeps extends Pick<LockDeps, 'isAlive'> {
  me: LockHolder;
}

/** Правка под замком; ждём замок ограниченно, чужой мёртвый замок перехватывается. */
async function withProcsLock(
  path: string,
  deps: ProcsDeps,
  edit: (current: ProcsFile) => Promise<ProcsFile> | ProcsFile,
): Promise<ProcsFile> {
  const lock = `${path}.lock`;
  const lockDeps: LockDeps = {
    isAlive: deps.isAlive,
    isSilent: (_holder, ageMs) => ageMs > LOCK_SILENT_MS,
    now: Date.now,
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt += 1) {
    const got = await acquireExclusive(lock, deps.me, lockDeps);
    if (got.acquired) {
      try {
        const read = readProcs(path);
        // Негодный файл не обнуляет чужие строки молча: отказ, а не перезапись с нуля.
        if ('unknown' in read) throw new Error(`procs.json unreadable: ${read.unknown}`);
        const current: ProcsFile = 'value' in read ? read.value : { v: 1, cores: [], servers: [] };
        const next = procsFileSchema.parse(await edit(current));
        writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
        return next;
      } finally {
        releaseExclusive(lock, deps.me.leaseId);
      }
    }
    // Ждём, не блокируя цикл событий: удары аренды и API идут, пока чужое ядро правит файл.
    await new Promise((resolve) => setTimeout(resolve, 15 + (attempt % 5) * 5));
  }
  throw new Error('procs.json lock not acquired');
}

/** Своя строка ядра: мёртвые чужие строки (pid + старт мертвы) убираются, живые и `unknown` остаются. */
export function registerCore(path: string, entry: ProcEntry, deps: ProcsDeps): Promise<ProcsFile> {
  return withProcsLock(path, deps, async (current) => {
    const keep: ProcEntry[] = [];
    for (const other of current.cores) {
      if (other.bootId === entry.bootId) continue;
      const live = await deps.isAlive({ pid: other.pid, start: other.pidStart });
      if (live !== 'dead') keep.push(other);
    }
    return { ...current, cores: [...keep, entry] };
  });
}

export function unregisterCore(path: string, bootId: string, deps: ProcsDeps): Promise<ProcsFile> {
  return withProcsLock(path, deps, (current) => ({
    ...current,
    cores: current.cores.filter((c) => c.bootId !== bootId),
  }));
}

/** Строка сервера (хост звеньев, сервер моделей, заглушка); мёртвые строки той же пары уходят. */
export function registerServer(
  path: string,
  entry: ServerEntry,
  deps: ProcsDeps,
): Promise<ProcsFile> {
  return withProcsLock(path, deps, async (current) => {
    const keep: ServerEntry[] = [];
    for (const other of current.servers) {
      if (other.kind === entry.kind && other.id === entry.id && other.pid === entry.pid) continue;
      const live = await deps.isAlive({ pid: other.pid, start: other.pidStart });
      if (live !== 'dead') keep.push(other);
    }
    return { ...current, servers: [...keep, entry] };
  });
}

export function unregisterServer(
  path: string,
  match: { kind: ServerEntry['kind']; id: string; pid: number },
  deps: ProcsDeps,
): Promise<ProcsFile> {
  return withProcsLock(path, deps, (current) => ({
    ...current,
    servers: current.servers.filter(
      (s) => !(s.kind === match.kind && s.id === match.id && s.pid === match.pid),
    ),
  }));
}

/**
 * Где слушает сборка: читатели (панель, прокладки) ищут ядро только здесь. Негодный файл —
 * `unknown`, а не пустой список: «ядро не запущено» и «не смог прочитать» ведут к разному (P44).
 */
export function findCore(
  path: string,
  build?: string,
): { value: ProcEntry[] } | { absent: true } | { unknown: string } {
  const read = readProcs(path);
  if (!('value' in read)) return read;
  return { value: read.value.cores.filter((c) => build === undefined || c.build === build) };
}
