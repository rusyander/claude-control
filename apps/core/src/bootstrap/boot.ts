import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { createAdapterRegistry, type AdapterRegistry } from '../adapters/index.ts';
import {
  createSessionTokens,
  type SessionTokens,
} from '../policy/session-tokens/session-tokens.ts';
import { createTaskRegistry, type TaskRegistry } from '../conductor/tasks.ts';
import type { ActionFactReaders } from '../conductor/reconcile.ts';
import { runDailyBackup } from '../journal/backup.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { createClock, REAL_CLOCK, type CoreClock } from '../platform/clock.ts';
import { ensureCoreHome, type CoreHomeLayout } from '../platform/core-home.ts';
import type { Fact } from '../platform/os-kind.ts';
import { LOOPBACK, listenOnAllocatedPort, type PortDecision } from '../platform/ports.ts';
import {
  createLivenessProbe,
  identityOfPid,
  type ProcessIdentity,
} from '../platform/process-identity.ts';
import { registerCore, unregisterCore } from '../platform/procs-file.ts';
import { openAppendLog } from '../platform/safe-io/append-log.ts';
import { ensureTokenFile } from '../platform/token-file.ts';
import type { RouteRegistry } from '../routes/registry.ts';
import { actionReaders } from './action-readers.ts';
import { buildCoreApi } from './boot-api.ts';
import { createBootReconcile, RECONCILE_EVERY_MS } from './boot-reconcile.ts';
import { buildCoreRoutes, readRouteConfig, type CoreRouteConfig } from './core-routes.ts';
import { shutdownRoutes } from './route-shutdown.ts';
import { dlpSecretMask } from './secret-mask.ts';
import {
  createSessionRoad,
  memoLoginPath,
  type LoginPathReader,
  type ResourceReaders,
  type SessionRoad,
} from './session-road.ts';
import { liveCopiesOf } from './session-road/protected-step.ts';
import { createSessionRuntime, type SessionRuntime } from './session-runtime.ts';

/**
 * Загрузка ядра (00 §Processes, 07 фаза 2): дом → токен → своя личность (pid + старт от ОС) →
 * незаконченные задачи через один `resume()` → сверка начатых действий и сессий (по задаче:
 * одна сбойная задача отделяется, загрузка идёт — ревью F-49) → API на 127.0.0.1 вне 5170–5180
 * → строка в `procs.json` → резервная копия дня → тики часов. Сбой загрузки после первых
 * ресурсов откатывает их (аренды, маршруты, порт). Всё решённое — в `logs/core.jsonl`.
 */

export const BACKUP_EVERY_MS = 6 * 60 * 60_000;

export interface BootedCore {
  layout: CoreHomeLayout;
  port: number;
  url: string;
  bootId: string;
  registry: TaskRegistry;
  app: FastifyInstance;
  clock: CoreClock;
  /** Чеканка и проверка токенов сессий — для запускателя сессий (03). */
  sessionTokens: SessionTokens;
  /** Маршруты ядра; чистая остановка освобождает всё, что они держат. */
  routes: RouteRegistry;
  /** Переходники CLI ядра (по id решения compat). */
  adapters: AdapterRegistry;
  /** Живые сессии: запущенная сессия прикрепляется сюда — её вопросы о праве решает ядро. */
  sessions: SessionRuntime;
  /**
   * ОДНА дорога сессии ядра (03 §Launcher): совместимость → окружение → токен → хук + оверлей →
   * запуск → прикрепление → поиск ресурсов на остановке → снятие в конце задачи.
   */
  road: SessionRoad;
  stop(): Promise<void>;
}

export interface BootOptions {
  home?: string;
  build?: string;
  log?: (line: string) => void;
  /** Личность своего процесса; по умолчанию — таблица ОС. Шов для теста отказа загрузки. */
  identity?: (pid: number) => Promise<Fact<ProcessIdentity>>;
  /**
   * Реестр маршрутов целиком (тест одного маршрута); по умолчанию — `buildCoreRoutes`: вход CLI
   * на каждый переходник + заглушки и своя модель из `routeConfig`.
   */
  routes?: RouteRegistry;
  /** Раздел `routes` настройки; по умолчанию — из `config.json` дома ядра (нет файла — пусто). */
  routeConfig?: CoreRouteConfig;
  /** Реестр переходников; по умолчанию — все переходники ядра с их настройками по умолчанию. */
  adapters?: AdapterRegistry;
  /** Сколько вопрос о праве ждёт запроса инструмента в потоке сессии (мс). */
  permitSettleMs?: number;
  /** Читатели фактов сверки; по умолчанию — `actionReaders()` (шов для теста сверки). */
  readers?: ActionFactReaders;
  /** Шаг повторной сверки нерешённого (мс); по умолчанию `RECONCILE_EVERY_MS`. */
  reconcileEveryMs?: number;
  /**
   * PATH оболочки входа для окружения CLI (P104); по умолчанию — настоящее чтение
   * (`platform/shell-path`), один раз на загрузку. Шов для теста дороги сессии.
   */
  loginPath?: LoginPathReader;
  /** Читатели ресурсов сессии (порты, рабочие копии, контейнеры); шов для теста. */
  resourceReaders?: ResourceReaders;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function bootCore(options: BootOptions = {}): Promise<BootedCore> {
  const self = await (options.identity ?? identityOfPid)(process.pid);
  if (!('value' in self)) {
    // Без своей личности аренду не доказать: другое ядро сочтёт её мёртвой. Отказ, а не догадка —
    // и до первого побочного действия: ни дома, ни журнала, ни токена, ни строки в procs.json.
    const why = 'unknown' in self ? self.unknown : 'own pid not in the process table';
    throw new Error(`core identity unknown: ${why}`);
  }
  const layout = ensureCoreHome(options.home);
  const log = openAppendLog(join(layout.logs, 'core.jsonl'));
  const note = (event: string, data: Record<string, unknown>): void => {
    log.append(Buffer.from(`${JSON.stringify({ at: Date.now(), event, ...data })}\n`));
  };
  const adapters = options.adapters ?? createAdapterRegistry();
  // `bootId` — до маршрутов: он владеет местами ждущих своей модели (11 R:PR-04). Часы с базой
  // тиков создаются позже, перед самими тиками (ревью F-50); до них журнал штампует теми же
  // часами без базы — штамп от базы не зависит.
  const bootId = newId();
  const stamps = createClock(REAL_CLOCK, bootId);
  // Решения маршрута вне аренды задачи (снятое место ждущего упавшего ядра) — в журнал ядра.
  const routeJournal: RouteRecorder = {
    decision: (record) => note('route.decision', { record }),
    created: (resource) => note('route.created', { resource }),
    verified: (rid, fact) => note('route.released', { rid, fact }),
    leak: (rid, reason) => note('route.leak', { rid, reason }),
  };
  let routes: RouteRegistry;
  try {
    routes =
      options.routes ??
      buildCoreRoutes(adapters, layout, options.routeConfig ?? readRouteConfig(layout), {
        bootId,
        journal: routeJournal,
      });
  } catch (error) {
    // Настройка маршрутов не той формы — отказ до аренды задач, порта и строки в procs.json.
    note('boot.refused', { reason: reasonOf(error) });
    log.close();
    throw error;
  }
  const sessions = createSessionRuntime({ settleMs: options.permitSettleMs, note });
  const probe = createLivenessProbe();
  const build = options.build ?? process.env.AGENTDECK_CORE_BUILD ?? 'dev';
  const me = { build, pid: process.pid, pidStart: self.value.start, bootId };
  const startedAt = Date.now();
  const registry = createTaskRegistry(layout.tasks, {
    me,
    clock: stamps,
    mask: dlpSecretMask,
    isAlive: (id) => probe.isAlive(id),
    now: Date.now,
    onLeaseLost: (taskId) => note('lease.lost', { taskId }),
  });
  const lockHolder = { leaseId: newId(), ...me, acquiredAt: Date.now() };
  const procsDeps = {
    isAlive: (id: { pid: number; start: string }) => probe.isAlive(id),
    me: lockHolder,
  };

  // Всё, что загрузка уже взяла: при сбое дальше — откат, чтобы аренды, удары, маршруты и порт
  // не пережили неудачную загрузку (ревью F-49).
  let app: FastifyInstance | undefined;
  let registered = false;
  let stopReconcile: (() => Promise<void>) | undefined;
  try {
    note('routes', { ids: routes.list().map((route) => route.id) });
    const token = ensureTokenFile(layout.token);
    const opened = await registry.openUnfinished();
    note('tasks.opened', { opened: opened.opened.length, refused: opened.refused });

    const reconcile = createBootReconcile({
      registry,
      readers: options.readers ?? actionReaders(),
      isAlive: (id) => probe.isAlive(id),
      note,
      now: Date.now,
    });
    await reconcile.atBoot(opened.opened);
    stopReconcile = reconcile.start(options.reconcileEveryMs ?? RECONCILE_EVERY_MS);

    // Токены сессий выводятся из ключа ядра (03): сессия, пережившая ядро, говорит с новым тем же
    // токеном. Запускатель сессий берёт `sessionTokens` из загрузки и чеканит токен шага.
    const sessionTokens = createSessionTokens(token.token);
    const health = { build, bootId, pid: process.pid, startedAt, home: layout.root };
    const api = buildCoreApi({
      registry,
      layout,
      coreToken: token.token,
      sessionTokens,
      sessions,
      health,
      note,
    });
    app = api;
    const decision: PortDecision = await listenOnAllocatedPort(async (port) => {
      await api.listen({ host: LOOPBACK, port });
    });
    const url = `http://${LOOPBACK}:${decision.port}`;
    note('port', { port: decision.port, rejected: decision.rejected });
    const road = createSessionRoad({
      url,
      layout,
      sessionTokens,
      routes,
      adapters,
      sessions,
      loginPath: memoLoginPath(options.loginPath, note),
      note,
      liveCopies: () => liveCopiesOf(registry),
      ...(options.resourceReaders ? { readers: options.resourceReaders } : {}),
    });

    await registerCore(
      layout.procs,
      {
        build,
        pid: process.pid,
        pidStart: self.value.start,
        bootId,
        port: decision.port,
        url,
        startedAt,
        home: layout.root,
        portDecision: { rejected: decision.rejected },
      },
      procsDeps,
    );
    registered = true;

    const backup = (): void => {
      // Таймер копии не роняет ядро (ревью M4): проход сам не бросает, этот перехват — на
      // непредвиденное (снимок реестра, сбой ФС вне названных шагов).
      try {
        const live = registry.liveTasks().map((t) => t.taskId);
        const outcome = runDailyBackup({
          backupsDir: layout.backups,
          tasksDir: layout.tasks,
          profilesDir: layout.profiles,
          activeTaskIds: live,
          at: Date.now(),
        });
        if (!outcome.skipped || outcome.failures.length) note('backup', { ...outcome });
      } catch (error) {
        note('backup', { failures: [reasonOf(error)] });
      }
    };
    backup();
    const backupTimer = setInterval(backup, BACKUP_EVERY_MS);
    backupTimer.unref?.();

    // База тиков — сейчас, после всей работы загрузки: долгая загрузка не скачок часов (F-50).
    const clock = createClock(REAL_CLOCK, bootId);
    const stopClock = clock.start((jump) => {
      for (const task of registry.liveTasks()) {
        try {
          task.append({ kind: 'clock.jump', actor: 'core', data: jump });
        } catch (error) {
          // Задачу только что перехватили: её скачок запишет новый владелец.
          note('clock.jump.skipped', { taskId: task.taskId, reason: String(error) });
        }
      }
    });

    options.log?.(`agentdeck core ${build} on ${url} (home ${layout.root})`);
    let stopped = false;
    return {
      layout,
      port: decision.port,
      url,
      bootId,
      registry,
      app: api,
      clock,
      sessionTokens,
      routes,
      adapters,
      sessions,
      road,
      async stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(backupTimer);
        stopClock();
        // Каждый шаг остановки идёт, даже если предыдущий упал (ревью F-107): строка в procs.json
        // и журнал ядра закрываются всегда; сбой называется после всех шагов.
        const failures = await releaseAll(
          [
            () => stopReconcile?.(),
            () => api.close(),
            async () => {
              // Чистая остановка — серверы маршрутов уходят вместе с ядром; при крахе сюда не
              // доходит, и они остаются для следующего ядра (P10).
              const released = await shutdownRoutes(routes, note);
              note('routes.stopped', {
                released: released.verified.length,
                leaks: released.leaks.length,
              });
            },
            () => registry.closeAll(),
            () => unregisterCore(layout.procs, bootId, procsDeps),
          ],
          note,
        );
        note('stop', failures.length ? { failures: failures.map(reasonOf) } : {});
        log.close();
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'core stop failed');
      },
    };
  } catch (error) {
    note('boot.failed', { reason: reasonOf(error) });
    await releaseAll(
      [
        () => stopReconcile?.(),
        () => app?.close(),
        () => shutdownRoutes(routes, note),
        () => registry.closeAll(),
        () => (registered ? unregisterCore(layout.procs, bootId, procsDeps) : undefined),
      ],
      note,
    );
    log.close();
    throw error;
  }
}

/** Шаги освобождения по порядку; сбой одного не отменяет следующих — он возвращается. */
async function releaseAll(
  steps: readonly (() => unknown)[],
  note: (event: string, data: Record<string, unknown>) => void,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
      note('release.failed', { reason: reasonOf(error) });
    }
  }
  return failures;
}
