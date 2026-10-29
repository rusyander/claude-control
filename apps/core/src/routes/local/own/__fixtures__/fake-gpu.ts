import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GpuMemory } from '../../../../platform/gpu.ts';
import { hasValue, type Fact } from '../../../../platform/os-kind.ts';
import {
  createLivenessProbe,
  identityOfPid,
  type Liveness,
  type ProcessIdentity,
} from '../../../../platform/process-identity.ts';
import { osProcessTable } from '../../../../platform/process-table.ts';

// Подставная память карты для тестов `local:own` и подставного ядра: базовое занятое + байты
// ЖИВЫХ раннеров (раннер пишет `<pid>.json` в каталог памяти) — сирота держит память, как у
// владельца 12.09.

export const GIB = 1024 ** 3;
export const TOTAL = 8 * GIB;
export const BASE_USED = 1 * GIB;
export const RUNNER_BYTES = 2 * GIB;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Linux: сигнал 0 доходит и до зомби (вышел, родитель ещё не собрал) — таблица ядра читает
  // его мёртвым, проверка тоже (полный прогон 28.10 в контейнере: «жив» через миг после остановки).
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

/** Личность процесса сейчас, одним свежим снимком; нет её — проверка не начинается. */
export async function identityNow(pid: number): Promise<ProcessIdentity> {
  const fact = await identityOfPid(pid);
  if (!hasValue(fact)) throw new Error(`no identity for pid ${pid}: ${JSON.stringify(fact)}`);
  return fact.value;
}

/**
 * Жив ли ИМЕННО этот процесс — для «сервер/раннер остановлен». Windows отдаёт номер умершего
 * процесса новому за секунды, и проверка по номеру читала остановленный сервер живым (полный
 * прогон 28.10, own.restart: «alive(pid) → true» сразу после «tree stopped … none alive»).
 * «unknown» (таблица не прочиталась) — не «dead»: проверка остаётся красной, не зеленеет.
 */
export const livenessNow = (id: ProcessIdentity): Promise<Liveness> =>
  createLivenessProbe(undefined, 0).isAlive(id);

export interface RunnerFile {
  pid: number;
  bytes: number;
  /** Когда раннер записал файл (его часы); нет — файл старого вида. */
  writtenAt?: number;
}

export function readRunners(vramDir: string): RunnerFile[] {
  return readdirSync(vramDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(vramDir, file), 'utf8')) as RunnerFile);
}

/** Linux: старт процесса из `btime` (целые секунды) — точность до секунды. */
export const START_SLACK_MS = 1_000;

/**
 * Живые раннеры — по личности, не по номеру: Windows отдаёт номер умершего процесса новому за
 * секунды (замер 28.10: 5 повторов за 12 с одного запускающего), и чужой процесс с номером давно
 * снятого раннера держал бы «память карты» (полный прогон 28.10: «vram not back: used 3.00 GiB»).
 * Процесс, стартовавший ПОСЛЕ записи файла раннера, — не раннер. Таблица не прочиталась — живые
 * по номеру считаются (в сторону «память не вернулась», не в сторону ложного «вернулась»).
 */
export async function liveRunnerFiles(vramDir: string): Promise<RunnerFile[]> {
  const byPid = readRunners(vramDir).filter((runner) => alive(runner.pid));
  if (byPid.length === 0) return [];
  const table = await osProcessTable().read();
  if (!hasValue(table)) return byPid;
  return byPid.filter((runner) => {
    const row = table.value.find((item) => item.pid === runner.pid);
    if (!row || row.zombie) return false;
    if (runner.writtenAt === undefined || !Number.isFinite(row.startMs)) return true;
    return row.startMs <= runner.writtenAt + START_SLACK_MS;
  });
}

export function fakeGpu(
  vramDir: string,
  seen: (pid: number) => void = () => undefined,
): () => Promise<Fact<GpuMemory>> {
  return async () => {
    for (const runner of readRunners(vramDir)) seen(runner.pid);
    const live = await liveRunnerFiles(vramDir);
    const used = BASE_USED + live.reduce((s, r) => s + r.bytes, 0);
    return {
      value: {
        source: 'nvidia-smi',
        devices: [
          {
            id: '0',
            name: 'Fake GPU',
            totalBytes: TOTAL,
            usedBytes: used,
            freeBytes: TOTAL - used,
          },
        ],
        unified: false,
      },
    };
  };
}
