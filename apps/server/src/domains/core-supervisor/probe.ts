import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_EXIT_FILE } from '@agentdeck/contracts/core/supervisor';
import { maskSecretsInText } from '@agentdeck/dlp/secret-mask';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import { locateCore, verifyCore } from '../core-proxy/core-proxy.ts';
import type { CoreExit, CoreProbe } from './core-supervisor.types.ts';
import { CORE_LOG_FILES } from './launch.ts';

/**
 * Что видно в доме ядра: та же строка `procs.json` и та же сверка ОС, что у прокладки (F-19) —
 * надзор считает ядро поднятым ровно тогда, когда прокладка отдаст ему bearer.
 */
export function createCoreProbe(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): () => Promise<CoreProbe> {
  return async () => {
    const core = locateCore(home());
    if ('missing' in core) return { kind: 'absent', reason: core.missing };
    const os = identity(core.entry.port);
    const proven = await verifyCore(core, os);
    if ('value' in proven) return { kind: 'up', pid: core.entry.pid };
    const reason = 'unknown' in proven ? proven.unknown : 'absent';
    if ((await os.exists(core.entry.pid)) === false)
      return { kind: 'absent', reason: `core pid ${core.entry.pid} is gone: ${reason}` };
    return { kind: 'unverified', pid: core.entry.pid, reason };
  };
}

const TAIL_BYTES = 64 * 1024;

function lastLines(file: string, max: number): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    // Первая строка обрезанного окна — чаще всего половина строки.
    if (size > length) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
    return lines.slice(-max);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Хвост журнала для карточки сбоя: последние строки вывода и ошибок ядра (стек падения — в
 * ошибках), каждая через маску секретов — ключ из окружения, напечатанный падением, не уйдёт
 * на экран и в телефон.
 */
export function readCoreLogTail(home: string, max = 40): string[] {
  const err = lastLines(join(home, CORE_LOG_FILES.err), Math.floor(max / 2));
  const out = lastLines(join(home, CORE_LOG_FILES.out), max - err.length);
  return [...out, ...err].map((line) => maskSecretsInText(line));
}

/**
 * Итог выхода ядра с этим pid из `core.exit.json`; файла нет, он битый или от другого процесса
 * (прошлое ядро, pid переиспользован не им) — `null`: чужой код карточке не нужен.
 */
export function readCoreExit(home: string, pid: number): CoreExit | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(home, CORE_EXIT_FILE), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const rec = raw as { pid?: unknown; code?: unknown; signal?: unknown };
    if (rec.pid !== pid) return null;
    const code = typeof rec.code === 'number' ? rec.code : null;
    const signal = typeof rec.signal === 'string' ? rec.signal : null;
    return code === null && signal === null ? null : { code, signal };
  } catch {
    return null;
  }
}
