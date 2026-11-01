import { dirname, join } from 'node:path';
import { livePin, type LiveRoot } from '../../adapters/conformance/__fixtures__/live.ts';
import { replayEnv } from '../../adapters/conformance/__fixtures__/replay.ts';
import { CREATED, FIRST_ROUND, SOLO_UNIT } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { BootedCore } from '../boot.ts';
import type { RoadStart } from '../session-road.ts';

/**
 * Запуск дорогой сессии ядра на подставном CLI (запись живого): задача с разрешённым маршрутом
 * входа CLI, единица, шаг в `running` и `RoadStart` с пином стенда и PATH к подставному CLI.
 */

export const loginRoute = (adapterId: string): string => `cli-login:${adapterId}`;

export async function roadTask(
  core: BootedCore,
  adapterId: string,
  opts: { allowed?: boolean; sourceRepo?: string } = {},
): Promise<LiveTask> {
  return core.registry.create({
    ...CREATED,
    ...(opts.sourceRepo
      ? { repos: [{ repoKey: 'r1', path: opts.sourceRepo, baseRef: 'main' }] }
      : {}),
    allowedRoutes:
      opts.allowed === false
        ? []
        : [
            {
              adapter: adapterId,
              route: { kind: 'cli-login', id: loginRoute(adapterId) },
              modelPattern: '*',
            },
          ],
  });
}

export interface RoadStartInput {
  live: LiveRoot;
  /** Каталог подставного CLI (первым в PATH сессии). */
  bin: string;
  task: LiveTask;
  adapterId: string;
  fixture: string;
  dump: string;
  denyCommands?: string[][];
  layer?: RoadStart['layer']['hooks'];
}

export function roadStart(input: RoadStartInput): RoadStart {
  const { live, task } = input;
  const stepId = newId();
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      repoKey: 'r1',
      branch: `agentdeck/${unitId.slice(-8)}`,
      ownedPaths: [],
      ...SOLO_UNIT,
    },
  });
  task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: { stepId, unitId, stepKind: 'work', budgetMs: 600_000, ...FIRST_ROUND },
  });
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    data: { stepId, event: 'start', from: 'queued', to: 'running' },
  });
  const sessionId = newId();
  return {
    task,
    stepId,
    stepKind: 'work',
    adapterId: input.adapterId,
    routeId: loginRoute(input.adapterId),
    model: 'stub-model',
    sessionId,
    dir: join(live.sessions, sessionId),
    cwd: live.cwd,
    brief: 'BRIEF_MARKER road test',
    deny: {
      paths: [],
      commands: input.denyCommands ?? [['git', 'push']],
      mcpTools: [],
      tools: [],
    },
    tools: 'all',
    layer: { hooks: input.layer ?? 'on', skills: 'on' },
    pin: livePin(live, replayEnv({ fixture: input.fixture, dump: input.dump })),
    pathPrefix: [input.bin, dirname(process.execPath)],
  };
}
