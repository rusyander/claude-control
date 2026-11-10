import type { FastifyInstance } from 'fastify';
import {
  RECORDED_VERDICTS,
  type RecordedRecordBody,
  type RecordedRecordReply,
  type RecordedReplayBody,
  type RecordedReplayState,
  type RecordedVerdictBody,
  type RecordedView,
  type RecordedWalkBody,
  type RecordedWalkReply,
} from '@agentdeck/contracts/project-tests-recorded';
import { defaultTestsCorePort } from '../../../domains/project-tests/agent/agent-runs.ts';
import { ProjectTestsError } from '../../../domains/project-tests/files.ts';
import { readEnvironments } from '../../../domains/project-tests/library/library.ts';
import {
  RecordedReplays,
  type RecordedWalkPort,
  createCoreWalkPort,
  recordWalk,
  recordedCases,
} from '../../../domains/project-tests/recorded/recorded.ts';
import { pickEnvironmentId } from '../../../domains/project-tests/runs/runs.ts';
import {
  assertOwnProject,
  assertUnlocked,
  guard,
  guardAsync,
  requireRoot,
  type TestsDeps,
} from '../shared/shared.ts';

/**
 * Записанные проходы по стенду (R3–R4): список с историей, «Записать сценарий» (задача прохода
 * в ядре, потом запись её строк в кейс и спек), «Прогнать все» без модели и решение человека по
 * первому расхождению. Пишет в дерево проекта и запускает прогон — только у проекта реестра и
 * копий его ветки (403), как своя команда прогона.
 */

export interface RecordedRoutesOptions {
  /** Порт ядра для задач прохода; нет — ядро панели. */
  walk?: RecordedWalkPort;
  replays?: RecordedReplays;
}

const GOAL_MAX = 4000;

export function registerRecordedRoutes(
  app: FastifyInstance,
  deps: TestsDeps,
  options: RecordedRoutesOptions = {},
): void {
  let walk = options.walk;
  const walkPort = (): RecordedWalkPort => (walk ??= createCoreWalkPort(defaultTestsCorePort()));
  const replays =
    options.replays ??
    new RecordedReplays({
      walk: { open: (request) => walkPort().open(request) },
      appData: deps.ctx.location.paths.appData,
    });

  app.get<{ Querystring: { path?: string } }>('/api/project-tests/recorded', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, (): RecordedView => {
      const replay = replays.state(root);
      return { cases: recordedCases(root), ...(replay ? { replay } : {}) };
    });
  });

  app.post<{ Body: Partial<RecordedRecordBody> }>(
    '/api/project-tests/recorded',
    (request, reply) => {
      const body = request.body ?? {};
      const root = requireRoot(body.path, reply);
      if (!root) return reply;
      return guard(reply, (): RecordedRecordReply => {
        assertOwnProject(deps, root);
        const groupId = String(body.groupId ?? '');
        if (!groupId) throw new ProjectTestsError('Назовите группу, в которую лечь кейсу.');
        assertUnlocked(deps, root, groupId);
        if (typeof body.taskId !== 'string' || !body.taskId) {
          throw new ProjectTestsError('Нет задачи прохода, из которой записывать.');
        }
        return recordWalk(
          root,
          {
            path: root,
            groupId,
            title: String(body.title ?? ''),
            taskId: body.taskId,
            steps: Array.isArray(body.steps) ? body.steps : [],
            gaps: Array.isArray(body.gaps) ? body.gaps : [],
            ...(typeof body.caseId === 'string' && body.caseId ? { caseId: body.caseId } : {}),
          },
          new Date().toISOString(),
        );
      });
    },
  );

  app.post<{ Body: Partial<RecordedWalkBody> }>(
    '/api/project-tests/recorded/walk',
    async (request, reply) => {
      const body = request.body ?? {};
      const root = requireRoot(body.path, reply);
      if (!root) return reply;
      return guardAsync(reply, async (): Promise<RecordedWalkReply> => {
        assertOwnProject(deps, root);
        const goal = String(body.goal ?? '').trim();
        if (!goal) throw new ProjectTestsError('Опишите, что пройти на стенде.');
        if (goal.length > GOAL_MAX) {
          throw new ProjectTestsError(`Описание длиннее ${GOAL_MAX} знаков.`);
        }
        const environments = readEnvironments(root);
        const envId = pickEnvironmentId(environments, body.environmentId);
        const environment = environments.find((item) => item.id === envId);
        const title = String(body.title ?? '').trim() || goal.slice(0, 80);
        return walkPort().open({
          root,
          title: `Проход по стенду: ${title}`,
          text: recordRequest(goal, environment?.baseUrl, envId, environment?.secrets ?? []),
        });
      });
    },
  );

  app.post<{ Body: Partial<RecordedReplayBody> }>(
    '/api/project-tests/recorded/replay',
    (request, reply) => {
      const body = request.body ?? {};
      const root = requireRoot(body.path, reply);
      if (!root) return reply;
      return guard(reply, (): RecordedReplayState => {
        assertOwnProject(deps, root);
        return replays.start(root, {
          ...(body.environmentId ? { environmentId: body.environmentId } : {}),
        });
      });
    },
  );

  app.post<{ Body: Partial<RecordedVerdictBody> }>(
    '/api/project-tests/recorded/verdict',
    (request, reply) => {
      const body = request.body ?? {};
      const root = requireRoot(body.path, reply);
      if (!root) return reply;
      return guard(reply, (): RecordedReplayState => {
        const verdict = RECORDED_VERDICTS.find((item) => item === body.verdict);
        if (!verdict) throw new ProjectTestsError('Решение — «defect» или «stale».');
        return replays.verdict(root, verdict);
      });
    },
  );
}

/** Задача модели на запись — по-английски; цель человека — его словами. */
function recordRequest(
  goal: string,
  baseUrl: string | undefined,
  environmentId: string | undefined,
  secrets: { name: string }[],
): string {
  return [
    `Walk the stand ${baseUrl ?? '(the project stand)'}${environmentId ? ` (environment ${environmentId})` : ''} and do what the human asked:`,
    goal,
    'Every action becomes a step of a recorded browser scenario that later replays without a model:',
    'name targets by role and name, test id, label or visible text; end with browse_expect steps that prove the goal was reached.',
    secrets.length > 0
      ? `Fill credentials only by secret name: ${secrets.map((item) => item.name).join(', ')}.`
      : 'The environment declares no credentials.',
    'Do not change any code.',
  ].join('\n');
}
