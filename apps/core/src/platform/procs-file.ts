import {
  isLoopbackCoreUrl,
  procsFileSchema,
  type ProcEntry,
  type ProcsFile,
  type ServerEntry,
} from '@agentdeck/contracts/core/procs';
import {
  acquireExclusive,
  releaseExclusive,
  type LockDeps,
  type LockHolder,
} from './exclusive-lock.ts';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { readBytesSync } from './safe-io/files.ts';

// Схема строк, проверка loopback и личности ядра — в контрактах (`core/procs.ts`, core-s9 F10):
// ту же проверку зовёт прокладка панели. Здесь — только файл под замком.
export type { ProcEntry, ProcsFile, ServerEntry };

/**
 * Реестр процессов `<core home>/procs.json` (00 §Processes, P83): где слушает каждая сборка
 * ядра. Панель, прокладки и MCP-сервер находят ядро здесь (или в `AGENTDECK_CORE_URL` сессии).
 *
 * По 00 файлом владеет супервизор; во второй фазе супервизора ещё нет, поэтому ядро пишет свою
 * строку само — атомарной заменой под замком `procs.json.lock` с той же дисциплиной перехвата,
 * что у аренды (дельта спецификации в отчёте). Две сборки, стартовавшие разом, не теряют строк
 * друг друга: чтение-правка-запись идёт только под замком.
 */

/** Замок молчит дольше — держатель считается брошенным (если и мёртв). */
export const LOCK_SILENT_MS = 10_000;
/**
 * Ожидание замка — порог молчания плюс запас (F-29): ядро, убитое с замком и поднятое
 * автозапуском через секунды, иначе сдавалось раньше, чем брошенный замок становился
 * перехватываемым, — и падало в цикле перезапусков. Обе величины — от одной константы.
 */
export const LOCK_WAIT_MS = LOCK_SILENT_MS + 5_000;

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
