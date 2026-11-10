import type { ForgePort } from '@agentdeck/contracts/core/forge';
import type { PublisherCommandPort } from '../../conductor/commands/publisher-port.ts';
import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { createPublishQueue, type PublishQueue } from '../../publisher/queue/queue.ts';
import { readyJudge } from '../../publisher/ready/ready.ts';
import { forgeOfPanel } from '../panel-forge.ts';
import { commentBackOf } from '../panel-trackers.ts';
import { publishAttempt, type AttemptDeps, type ForgeAccess } from './attempt.ts';
import { cleanRemote } from './clean-remote.ts';
import { composeForGate, scenarioPublishes } from './compose.ts';
import { probeDelivery } from './delivery-probe.ts';
import { outboxPort } from './outbox-port.ts';
import { threadsSection } from './threads-brief.ts';

/**
 * Проводка публикатора (зона P этапа 6): крючки `onFinalGate` (композиция под состав) и
 * `onPublish` (одна попытка в очереди репозитория) поверх частей `publisher/*`, плюс порт команд
 * `publish-now` / `clean-remote`. Outbox — `outbox-port.ts` над `conductor/outbox.runAction`.
 */

export interface PublishWiringOptions {
  now?: () => number;
  git?: GitOptions;
  /** Форж по адресу пуша; `null` — форжа нет. По умолчанию — настройки панели. */
  forgeFor?: (url: string) => ForgeAccess | null;
  queue?: PublishQueue;
  /** Комментарий назад в тикет (Z7); по умолчанию — Jira панели под настройкой ядра. */
  commentBack?: AttemptDeps['commentBack'];
}

export interface PublishWiringDeps {
  registry: TaskRegistry;
  coreHome: string;
  scenariosDir: string;
  note: (event: string, data: Record<string, unknown>) => void;
  /** Каталог панели, решённый загрузкой; нет или `null` — форж по умолчанию без панели. */
  panelAppData?: string | null;
}

export interface PublishWiring {
  hooks: ConductorHooks;
  queue: PublishQueue;
  /** Порт команд `publish-now` / `clean-remote` (среда команды — запрос контракта P). */
  commands: PublisherCommandPort;
}

/**
 * Форж из настроек панели. Доступ к ПУШУ панель пока не отдаёт (её ключ закрыт в порту API) —
 * git берёт свой помощник; запрос контракта к зоне F.
 */
function defaultForgeFor(panelAppData: string | null | undefined) {
  const forgeOf = forgeOfPanel(panelAppData);
  return (url: string): ForgeAccess | null => {
    const remote = forgeOf(url);
    if (remote.project.kind === 'generic') return null;
    return { port: remote.port, credential: null };
  };
}

export function createPublishWiring(
  deps: PublishWiringDeps,
  options: PublishWiringOptions = {},
): PublishWiring {
  const git = options.git ?? {};
  const queue = options.queue ?? createPublishQueue();
  const attemptDeps = {
    coreHome: deps.coreHome,
    git,
    now: options.now ?? Date.now,
    forgeFor: options.forgeFor ?? defaultForgeFor(deps.panelAppData),
    judge: readyJudge(),
    outbox: outboxPort,
    commentBack:
      options.commentBack ??
      commentBackOf({ coreHome: deps.coreHome, panelAppData: deps.panelAppData, note: deps.note }),
  };
  return {
    queue,
    commands: {
      promote: (unitId) => queue.promote(unitId),
      cleanRemote: (task, input) => cleanRemote(task, input, git),
      delivery: (copy) => probeDelivery(attemptDeps, deps.registry, copy),
    },
    hooks: {
      async preStep(s) {
        const task = deps.registry.live(s.taskId);
        const section = task ? await threadsSection(attemptDeps, task, s) : null;
        return { verdict: { ok: true }, sections: section ? [section] : [] };
      },
      async onFinalGate(u, prior) {
        if (!prior?.verdict.ok || !prior.compositionId)
          return prior ?? { verdict: { ok: true }, compositionId: null };
        const task = deps.registry.live(u.taskId);
        if (!task || !(await scenarioPublishes(task, deps.scenariosDir))) return prior;
        const verdict = await composeForGate(task, u, prior.compositionId, {
          coreHome: deps.coreHome,
          git,
        });
        deps.note('publish.composed', { taskId: u.taskId, unitId: u.unitId, ok: verdict.ok });
        return { verdict, compositionId: verdict.ok ? prior.compositionId : null };
      },
      async onPublish(s, compositionId) {
        if (s.def.kind !== 'publish') return null;
        const task = deps.registry.live(s.taskId);
        if (!task) return null;
        const release = await queue.enter(s.repoKey, s.unitId);
        try {
          const got = await publishAttempt(attemptDeps, task, s, compositionId);
          deps.note('publish.attempt', { taskId: s.taskId, unitId: s.unitId, outcome: got.kind });
          return got;
        } finally {
          release();
        }
      },
    },
  };
}

export { outboxPort };
export type { ForgeAccess, ForgePort };
