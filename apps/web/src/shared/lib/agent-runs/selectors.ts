import { runStatus } from './status';
import { isOpenAsk } from '@shared/lib/chat-stream';
import type { PendingPermission, StreamedTool } from './agent-runs.types';
import type { RunLike } from './selectors.types';
import type { RunStatus } from './status.types';

export interface ActiveRunView {
  id: string;
  sessionId?: string;
  projectPath?: string;
  /** Статус с поправкой на зависание; idle сюда не попадает. */
  status: Exclude<RunStatus, 'idle'>;
  costUsd?: number;
  tokens?: number;
  /**
   * Чем ведётся прогон. Нужно с тех пор, как панель подбирает модель под задачу:
   * дети одного разделения идут РАЗНЫМИ моделями, звено проверки — сильнее
   * работы, и в пульте агентов «кто на чём» иначе не прочесть.
   */
  model?: string;
  /**
   * Вызовы прогона. Нужны не только его собственной ленте: вопрос дочернего
   * чата (`AskUserQuestion`) показывается и в РОДИТЕЛЬСКОМ разговоре, чтобы
   * человек отвечал всем из одного места, а не обходил шесть чатов по кругу.
   */
  tools?: StreamedTool[];
  /**
   * Запросы прав, ждущие решения. Как и вызовы, нужны не только своей ленте:
   * на запросе прав агент СТОИТ, поэтому запрос дочернего чата показывается и в
   * родительском разговоре — иначе про остановку узнают, обойдя все вкладки.
   */
  permissions?: PendingPermission[];
}

/**
 * Активные прогоны — те, у кого есть что показать точкой: работает, молчит,
 * ждёт ответа или упал. Завершённые (idle) отсеиваем. Порядок по тревожности:
 * сначала ошибки, потом ждущие, потом молчащие, потом работающие.
 */
export function selectActiveRuns(runs: RunLike[], now: number): ActiveRunView[] {
  const active: ActiveRunView[] = [];
  for (const run of runs) {
    const status = runStatus({
      status: run.status,
      lastEventAt: run.lastEventAt,
      now,
      pendingPermission: (run.permissions?.length ?? 0) > 0,
    });
    if (status === 'idle') continue;
    active.push({
      id: run.id,
      sessionId: run.sessionId,
      projectPath: run.projectPath,
      status,
      costUsd: run.costUsd,
      tokens: run.tokens,
      ...(run.model ? { model: run.model } : {}),
      // Вопросы носим только у тех, кто спрашивал: у остальных это лишний
      // массив на каждый пересчёт пульта агентов.
      ...(run.tools?.some(isOpenAsk) ? { tools: run.tools } : {}),
      // Права носим только у стоящих на них — по той же причине.
      ...(run.permissions?.length ? { permissions: run.permissions } : {}),
    });
  }

  const order: Record<Exclude<RunStatus, 'idle'>, number> = {
    error: 0,
    waiting: 1,
    quiet: 2,
    running: 3,
  };
  return active.sort((a, b) => order[a.status] - order[b.status]);
}
