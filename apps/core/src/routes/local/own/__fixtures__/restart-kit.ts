import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RouteDecisionRecord,
  RouteEndpoint,
  RouteLease,
  RouteRecorder,
  RouteResource,
} from '@agentdeck/contracts/core/routes';
import { hasValue } from '../../../../platform/os-kind.ts';
import { osProcessTable } from '../../../../platform/process-table.ts';
import { pathExists } from '../../../../platform/safe-io/files.ts';
import { createOwnRoute, type OwnRoute, type OwnRouteOptions } from '../own.ts';
import { createSlotQueue } from '../slot.ts';
import { alive, liveRunnerFiles, readRunners, START_SLACK_MS } from './fake-gpu.ts';
import { leaseDirs, readLeaseState, writeLeaseState } from '../lease-state.ts';
import { stopLeaseServers } from './lease-sweep.ts';
import { ownDir, ownOptions, type OwnDir } from './own-options.ts';

// Общее для проверок перезапуска `local:own` (P10): подставное ядро, убитое посреди аренды и
// очереди, новый экземпляр маршрута над тем же каталогом и уборка, которую не обходит красный тест.

const FAKE_CORE = fileURLToPath(new URL('./fake-own-core.ts', import.meta.url));
const FAKE_RESTORE = fileURLToPath(new URL('./fake-restore-core.ts', import.meta.url));

export const settle = (ms = 400): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Ждать условия не дольше `ms`; не дождались — ложь (проверку делает вызывающий). */
export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await settle(50);
  }
  return check();
}

export function recorder() {
  const events: string[] = [];
  const resources: RouteResource[] = [];
  const decisions: RouteDecisionRecord[] = [];
  const record: RouteRecorder = {
    decision: (d) => void decisions.push(d),
    created: (r) => void resources.push(r),
    verified: (_rid, fact) => void events.push(`verified:${fact}`),
    leak: (_rid, reason) => void events.push(`leak:${reason}`),
  };
  return { record, events, resources, decisions };
}

export function serverPid(lease: RouteLease): number {
  const ref = lease.resources.find((r) => r.kind === 'model-server')?.ref ?? '';
  const pid = Number(/^pid (\d+) /.exec(ref)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid in ${ref}`);
  return pid;
}

/** Живые раннеры по личности (номер умершего раннера мог достаться чужому процессу). */
export const liveRunners = async (layout: OwnDir): Promise<number[]> =>
  (await liveRunnerFiles(layout.vramDir)).map((r) => r.pid);

/** Номера раннеров для уборки — сейчас живых по номеру (уборка сверяет `alive` ещё раз). */
const runnerPids = (layout: OwnDir): number[] =>
  readRunners(layout.vramDir)
    .map((r) => r.pid)
    .filter(alive);

const waitingDir = (layout: OwnDir, suffix: string): string[] => {
  const dir = join(layout.workRoot, '.slot-waiting');
  return pathExists(dir) ? readdirSync(dir).filter((name) => name.endsWith(suffix)) : [];
};

/** Файлы мест ждущих на диске. */
export const waitFiles = (layout: OwnDir): string[] => waitingDir(layout, '.json');

/** Записи первой смерти владельцев мест (начало окна повторной выдачи). */
export const deadMarks = (layout: OwnDir): string[] => waitingDir(layout, '.dead');

/**
 * Процессы и маршруты одного набора проверок. `sweep` — в `afterAll`: красная проверка бросает
 * выдачи на полпути, остановка отпускает держимое, это выдаёт слот ждущим, те поднимают сервер —
 * круг повторяется, пока всё не осядет. Иначе хранитель с сервером переживают vitest (это их
 * назначение) и остаются жить после прогона.
 */
export function restartKit(root: string) {
  /** Процессы в уборку и миг, когда номер стал нашим: процесс, стартовавший позже, — чужой. */
  const owned: { pid: number; at: number }[] = [];
  const cleanup = {
    push: (...pids: number[]): number => {
      const at = Date.now();
      for (const pid of pids) owned.push({ pid, at });
      return owned.length;
    },
  };
  /** Подставные ядра: красная проверка не дойдёт до их убийства — их добивает уборка. */
  const cores: ChildProcess[] = [];
  const routes: OwnRoute[] = [];
  const pending: Promise<unknown>[] = [];

  const track = <T>(acquire: Promise<T>): Promise<T> => (pending.push(acquire), acquire);

  function restartedRoute(layout: OwnDir, extra: Partial<OwnRouteOptions> = {}) {
    const slots = createSlotQueue();
    const route = createOwnRoute({
      ...ownOptions(layout, 'normal', (pid) => void cleanup.push(pid)),
      slots,
      ...extra,
    });
    routes.push(route);
    return { route, slots };
  }

  /** Подставное ядро берёт аренду, ставит второй запрос («queued») в очередь и умирает без уборки. */
  async function killedCore(name: string): Promise<{
    layout: OwnDir;
    lease: RouteLease;
    endpoint: RouteEndpoint;
    corePid: number;
  }> {
    const layout = ownDir(mkdtempSync(join(root, `${name}-`)));
    const core = await fakeCore(FAKE_CORE, [layout.dir], /^LEASE (.*)$/m);
    await core.kill();
    const taken = JSON.parse(core.line) as { lease: RouteLease; endpoint: RouteEndpoint };
    // Сервер и раннеры — в уборку сразу: упавшая проверка ниже не оставит их жить.
    cleanup.push(serverPid(taken.lease), ...runnerPids(layout));
    return { layout, ...taken, corePid: core.pid };
  }

  /**
   * Аренды каталога — за ядром, доказанно мёртвым по личности (номер без процесса, чужой старт):
   * проверке, где живость упавшего ядра «неизвестна» ради окна места, аренда всё равно принимается
   * (F-88: аренду непрояснённого ядра не принимают).
   */
  function leasesOfDeadCore(layout: OwnDir): void {
    for (const dir of leaseDirs(layout.workRoot)) {
      const state = readLeaseState(dir);
      if (state)
        writeLeaseState(dir, {
          ...state,
          owner: { pid: 999_989, start: 'dead-core', bootId: 'previous-core' },
        });
    }
  }

  /**
   * Живое подставное ядро с арендой (сервер с моделью идёт) и ждущим «queued»; `kill` — смерть
   * без уборки. Сервер и раннеры — в уборку сразу, ядро — по объекту процесса.
   */
  async function liveCore(name: string): Promise<{
    layout: OwnDir;
    lease: RouteLease;
    corePid: number;
    kill(): Promise<void>;
  }> {
    const layout = ownDir(mkdtempSync(join(root, `${name}-`)));
    const core = await fakeCore(FAKE_CORE, [layout.dir], /^LEASE (.*)$/m);
    const taken = JSON.parse(core.line) as { lease: RouteLease };
    cleanup.push(serverPid(taken.lease), ...runnerPids(layout));
    return { layout, lease: taken.lease, corePid: core.pid, kill: core.kill };
  }

  /**
   * Ядро «B»: возвращает состояние над тем же каталогом, читает живость владельцев мест и живёт,
   * пока проверка его не убьёт. `unknownPid` — чья живость для него «неизвестна».
   */
  async function restoringCore(layout: OwnDir, unknownPid = 0) {
    const spawnedAt = Date.now();
    const core = await fakeCore(FAKE_RESTORE, [layout.dir, String(unknownPid)], /^(RESTORED)$/m);
    return { spawnedAt, readyAt: Date.now(), kill: core.kill };
  }

  /** Процесс подставного ядра до строки `ready`; убийство — без уборки (SIGKILL / TerminateProcess). */
  async function fakeCore(script: string, args: string[], ready: RegExp) {
    const core = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', script, ...args],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    const pid = core.pid ?? 0;
    cores.push(core);
    const exited = once(core, 'exit');
    const kill = async (): Promise<void> => {
      core.kill('SIGKILL');
      await exited;
    };
    let seen = '';
    const line = await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`${script} printed no ${ready} in 60 s`)),
        60_000,
      );
      core.stdout.on('data', (chunk) => {
        seen += chunk;
        const found = ready.exec(seen);
        if (found?.[1]) {
          clearTimeout(timer);
          done(found[1]);
        }
      });
      core.on('exit', (code) => fail(new Error(`${script} exited ${code} before ${ready}`)));
    }).catch(async (error: unknown) => {
      await kill();
      throw error;
    });
    return { pid, line, kill };
  }

  async function sweep(): Promise<void> {
    const quiet = recorder().record;
    for (let round = 0; round < 4; round += 1) {
      for (const route of routes) await route.shutdown(quiet).catch(() => undefined);
      const done = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        settle(10_000).then(() => false),
      ]);
      if (!done) continue;
      for (const route of routes) await route.shutdown(quiet).catch(() => undefined);
      break;
    }
    // По объекту процесса, не по pid: pid убитого ядра мог уже достаться чужому процессу.
    for (const core of cores) if (core.exitCode === null && core.signalCode === null) core.kill();
    // Сервер, к которому ни один маршрут не вернулся, — по записи аренды, деревом (POSIX тоже).
    await stopLeaseServers(root);
    // По личности, не по номеру: Windows отдаёт номер снятого процесса новому за секунды, и
    // уборка по `alive(pid)` убила бы чужой процесс. Таблица не прочиталась — никого не трогать.
    const table = await osProcessTable().read();
    if (!hasValue(table)) {
      console.warn(
        `restart-kit sweep: process table unreadable, not killed: ${owned.map((o) => o.pid).join(' ')}`,
      );
      return;
    }
    for (const { pid, at } of owned) {
      const row = table.value.find((item) => item.pid === pid);
      if (!row || row.zombie) continue;
      if (Number.isFinite(row.startMs) && row.startMs > at + START_SLACK_MS) continue;
      if (alive(pid)) process.kill(pid);
    }
  }

  return {
    cleanup,
    track,
    restartedRoute,
    killedCore,
    liveCore,
    leasesOfDeadCore,
    restoringCore,
    sweep,
  };
}
