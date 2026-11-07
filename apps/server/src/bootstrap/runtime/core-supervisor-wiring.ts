import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';
import { createHopGate, type HopGate } from '../../domains/core-proxy/hop-gate.ts';
import {
  CORE_SUPERVISE_ENV,
  CORE_AUTOSTART_NAME_ENV,
  createCoreAutostart,
  runCoreCommand,
  createCoreProbe,
  createCoreSupervisor,
  launchCore,
  readCoreExit,
  readCoreLogTail,
  type CoreAutostart,
  type CoreSupervisor,
} from '../../domains/core-supervisor/index.ts';
import { coreHomeOf, HOP_RECORD_ENV, watchHops, describeRecord } from '../../lib/hop-recorder.mjs';
import { killProcessTree } from '../../lib/kill-tree.mjs';
import {
  registerCoreProxyRoutes,
  type CoreProxyRegistration,
} from '../../routes/core-proxy/core-proxy-routes.ts';
import type { RouteRegistrar } from '../../routes/register.ts';

/**
 * Надзор за процессом ядра (этап 10, зона core-supervisor): приложение — один продукт.
 * Панель на старте усыновляет живое ядро своего дома или поднимает своё отвязанным, следит за
 * ним и поднимает заново после падения; `pnpm core` остаётся способом разработчика (живое ядро
 * усыновляется, второе рядом не поднимается).
 *
 * Звенья P131: при стороже (`dev-watch`, `keepalive`, стенд — `AGENTDECK_HOP_RECORD` в
 * окружении) звенья пишет он, каждому новому ядру. Без сторожа (приложение без dev-обвязки) —
 * сам надзор тем же `watchHops`: pid этого сервера записывается каждому поднятому ядру,
 * а прокладка ждёт итог этой записи прежде, чем переслать команду.
 *
 * Не поднимается: `AGENTDECK_CORE_SUPERVISE=0` (стенды QA со своим ядром) и под vitest —
 * тест, собравший рантайм, не должен поднимать настоящее ядро.
 */
export interface CoreSupervisorWiring {
  status(): CoreSupervisorStatus | null;
  /** Погасить надзор при выходе панели; само ядро её переживает. */
  stop(): void;
  supervisor?: CoreSupervisor;
  autostart?: CoreAutostart;
  /** Ворота записи звена надзора — только когда звенья пишет он сам. */
  hopGate?: HopGate;
}

export interface CoreSupervisorWiringOptions {
  /** Каталог данных панели: здесь лежит итог записи звеньев, когда её ведёт надзор. */
  appData: string;
  env?: NodeJS.ProcessEnv;
}

export function supervisionEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[CORE_SUPERVISE_ENV] !== '0' && !env.VITEST;
}

export function wireCoreSupervisor(options: CoreSupervisorWiringOptions): CoreSupervisorWiring {
  const env = options.env ?? process.env;
  if (!supervisionEnabled(env)) return { status: () => null, stop: () => undefined };
  const home = (): string => coreHomeOf(env);
  const log = (line: string): void => console.log(line);
  const autostartName = env[CORE_AUTOSTART_NAME_ENV]?.trim() || undefined;
  const autostart = createCoreAutostart(home, runCoreCommand, autostartName);
  let hops: { stop(): void } | undefined;
  let hopGate: HopGate | undefined;
  const watcherFile = env[HOP_RECORD_ENV];
  if (!watcherFile || watcherFile.trim() === '') {
    const file = join(options.appData, 'core-hops.json');
    const pids = [process.pid];
    const watch = watchHops({
      coreHome: home(),
      pidsOf: () => pids,
      file,
      onRecord: (results, recorded) => {
        const line = describeRecord(results, recorded);
        if (line) log(`core supervisor: ${line}`);
      },
    });
    void watch.refresh();
    hops = watch;
    hopGate = createHopGate({ file, pid: process.pid });
  }
  const supervisor = createCoreSupervisor({
    probe: createCoreProbe(home),
    spawn: () => launchCore({ home: home(), env }),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid) => {
      killProcessTree(pid);
    },
    logTail: () => readCoreLogTail(home()),
    exitRecord: (pid) => readCoreExit(home(), pid),
    autostart: () => autostart.state(),
    log,
    now: Date.now,
  });
  supervisor.start();
  void autostart.refresh().catch(() => undefined);
  return {
    status: () => supervisor.status(),
    stop: () => {
      supervisor.stop();
      hops?.stop();
    },
    supervisor,
    autostart,
    ...(hopGate ? { hopGate } : {}),
  };
}

/** Состояние надзора и его ручки: `null` — панель без надзора (ядро запускает разработчик). */
export function registerCoreSupervisorRoutes(app: FastifyInstance, wiring: CoreSupervisorWiring) {
  app.get('/api/core/supervisor', async () => wiring.status());
  // Кнопка «Перезапустить» карточки сбоя: счёт неудач с нуля, подъём сразу.
  app.post('/api/core/supervisor/restart', async (_request, reply) => {
    if (!wiring.supervisor) return reply.code(409).send(null);
    return wiring.supervisor.restart();
  });
  // Автозапуск ядра при входе в систему (P57: Планировщик, systemd, LaunchAgent).
  app.post<{ Body: { on?: unknown } }>('/api/core/supervisor/autostart', async (request, reply) => {
    if (!wiring.autostart) return reply.code(409).send(null);
    const on = request.body?.on;
    if (typeof on !== 'boolean') return reply.code(400).send({ error: 'on: boolean expected' });
    const got = await wiring.autostart.set(on);
    return reply.code(got.ok ? 200 : 502).send({ ok: got.ok, state: got.state });
  });
}

/**
 * Маршруты зоны ядра — таблица маршрутов вставляет их на прежнее место. Старт чата ядра из веба
 * (`/api/chat/core-start`, G13) снят с единым чатом (W3-17a): ход `/chat` сам становится задачей ядра.
 */
export function coreSupervisorRoutes(wiring: CoreSupervisorWiring): RouteRegistrar[] {
  const supervisor = wiring.supervisor;
  const registration: CoreProxyRegistration = {
    ...(supervisor
      ? { supervisor: { status: () => wiring.status(), whenUp: (ms) => supervisor.whenUp(ms) } }
      : {}),
    ...(wiring.hopGate ? { hopGate: wiring.hopGate } : {}),
  };
  return [
    (instance) => registerCoreSupervisorRoutes(instance, wiring),
    // Прокладка к ядру (07 фаза 2): дом ядра читается на каждом запросе — ядро могло
    // перезапуститься на другом порте; команда — строка `human:` журнала возможностей.
    (instance, context) => registerCoreProxyRoutes(instance, registration, context),
  ];
}
