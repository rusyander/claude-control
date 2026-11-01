import { join } from 'node:path';
import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { openAnswerTask, type SplitEnv } from '../../conductor/estimate/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { CopyGitOptions } from '../../platform/copy-git.ts';
import type { AnswerTaskRequest } from '../../publisher/events/poll.ts';
import type { Note } from '../boot/boot.types.ts';
import { forgePollOf } from './poll-config.ts';
import { createForgePoller } from './poller.ts';
import { createWatched } from './watched.ts';

/**
 * Опрос форжа в ядре (05:77-78): включение — `forgePoll` конфига ядра (каждый круг заново), MR —
 * из журналов законченных задач (`createWatched`), просьба — новая задача answer-reviewers через
 * дирижёра (`openAnswerTask`, та же дорога создания, что у оценки). Отказ открыть (ветка MR
 * отстала, сервер не прочитан, дирижёр не подключён) — ошибка: отметка опроса не двигается, и
 * заметка придёт снова на следующем круге, когда причину уберут.
 */

/** Файл отметок опроса в доме ядра: перезапуск не открывает задачу второй раз. */
export const FORGE_POLL_STATE = 'forge-poll.json';

export class AnswerTaskRefused extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`answer task refused: ${problems.join('; ')}`);
    this.name = 'AnswerTaskRefused';
    this.problems = problems;
  }
}

export interface PollWiringDeps {
  registry: TaskRegistry;
  /** Среда деления дирижёра; нет — дирижёр не подключён, задача не открывается. */
  split: () => SplitEnv | undefined;
  layout: { root: string; config: string };
  note: Note;
  git?: CopyGitOptions;
  forgeFor?: (url: string) => ForgePort;
  intervalMs?: number;
  now?: () => number;
}

export function createPollWiring(deps: PollWiringDeps) {
  const log = (message: string) => deps.note('forge.poll', { message });
  const watched = createWatched({
    registry: deps.registry,
    ...(deps.git ? { git: deps.git } : {}),
    log,
  });
  async function request(req: AnswerTaskRequest): Promise<void> {
    const env = deps.split();
    if (!env) throw new AnswerTaskRefused(['conductor not connected']);
    const got = await openAnswerTask(req, deps.registry, env, deps.git);
    if ('refused' in got) throw new AnswerTaskRefused(got.refused);
    deps.note('forge.poll.opened', {
      taskId: got.opened,
      fromTaskId: req.fromTaskId,
      mrIid: req.mrIid,
      events: req.events.length,
    });
  }
  return createForgePoller({
    enabled: () => forgePollOf(deps.layout.config),
    watched,
    request,
    stateFile: join(deps.layout.root, FORGE_POLL_STATE),
    log,
    ...(deps.forgeFor ? { forgeFor: deps.forgeFor } : {}),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),
    ...(deps.now ? { now: deps.now } : {}),
  });
}
