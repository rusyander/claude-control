import type { AgentsPort } from '../../api/agents.ts';
import { createLivenessProbe } from '../../platform/process-identity.ts';
import type { AgentsWiring, AgentsWiringDeps } from './agents-wiring.types.ts';
import { createFoldBook } from './folds.ts';
import { createAgentsPort } from './port.ts';
import { createBgWatch } from './watch.ts';

export type { AgentsBootOptions, AgentsWiring, AgentsWiringDeps } from './agents-wiring.types.ts';

/** Шаг обхода сторожа фона по умолчанию: сирота замечается за секунды, а не за минуты. */
export const BG_TICK_MS = 5_000;

/**
 * Проводка истории агентов (этап 11, P146-P149): свёртки журнала задач → порт API (дерево, узел,
 * список, поток, выгрузка) и сторож фона над живыми задачами (сирота → снос через ресурс,
 * зависание → показ). Живые задачи подхватываются обходом (`registry.liveTasks()`), строка
 * конца задачи зовёт проход сразу: работа, пережившая задачу, не ждёт следующего шага.
 */
export function createAgentsWiring(deps: AgentsWiringDeps): AgentsWiring {
  const folds = createFoldBook(deps.registry);
  const port: AgentsPort = createAgentsPort({ registry: deps.registry, folds, mask: deps.mask });
  const watch = createBgWatch({
    liveness: deps.liveness ?? createLivenessProbe(),
    note: deps.note,
    now: deps.now ?? Date.now,
    ...(deps.hangAfterMs !== undefined ? { hangAfterMs: deps.hangAfterMs } : {}),
    ...(deps.release ? { release: deps.release } : {}),
  });
  let stopped = false;
  let running: Promise<void> | null = null;

  const sweep = async (): Promise<void> => {
    if (stopped) return;
    const live = deps.registry.liveTasks();
    folds.prune(live.map((t) => t.taskId));
    for (const task of live) {
      const fold = folds.follow(task, (_fold, line) => {
        if (line.kind === 'task.ended') void sweepOnce();
      });
      await watch.sweepTask(task, fold);
    }
  };

  /** Проходы не перекрываются: идущий — ждём его, а не начинаем второй рядом. */
  const sweepOnce = async (): Promise<void> => {
    while (running) await running;
    running = sweep()
      .catch((error: unknown) =>
        deps.note('agents.sweep.failed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        running = null;
      });
    await running;
  };

  const tickMs = deps.tickMs ?? BG_TICK_MS;
  const timer = tickMs > 0 ? setInterval(() => void sweepOnce(), tickMs) : null;
  timer?.unref?.();

  return {
    port: () => port,
    sweep: sweepOnce,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      while (running) await running;
      folds.close();
    },
  };
}
