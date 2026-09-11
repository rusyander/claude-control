import { randomUUID } from 'node:crypto';
import type {
  ProjectTestFailure,
  ProjectTestManualResultInput,
  ProjectTestManualSession,
  ProjectTestPoint,
  ProjectTestPointResult,
  ProjectTestRunRecord,
} from '@agentdeck/contracts';
import { summarize } from '@agentdeck/contracts/test-format';
import { ProjectTestsError, ProjectTestsNotFoundError } from './files.ts';
import { applyResults, readGroups, selectCases } from './store.ts';
import { readEnvironments } from './library.ts';
import { buildPoints, planCases, readPlan } from './plans.ts';
import { gitContext, releaseTag } from './impact.ts';
import { writeRun } from './runs-store.ts';

/**
 * Ручной прогон: кейсы проходит ЧЕЛОВЕК, панель записывает.
 *
 * Это то, без чего тестировщик в панели не работает: до сих пор кейсы мог
 * пройти только агент, а человек лишь смотрел на галочки. Сессия живёт в
 * памяти (её открывает один человек в одном окне), но КАЖДЫЙ отмеченный
 * результат сразу уходит на диск — и в файл кейса, и в запись прогона.
 * Закрыл вкладку, выключил панель, сел за телефон — уже отмеченное не пропало.
 *
 * Сессия на проект одна: две параллельные означали бы два человека, пишущих
 * статусы в один файл, и никто бы не понял, чей результат победил.
 */
export class ProjectTestManualRegistry {
  private readonly sessions = new Map<string, ProjectTestManualSession>();

  /** Идущая сессия проекта. */
  get(projectPath: string): ProjectTestManualSession | undefined {
    return this.sessions.get(projectPath);
  }

  /** Начать ручной прогон по плану, группе или отобранным кейсам. */
  start(
    root: string,
    request: { planId?: string; groupId?: string; caseIds?: string[]; environmentId?: string },
    now: string,
    assertUnlocked?: (groupId: string) => void,
  ): ProjectTestManualSession {
    const active = this.sessions.get(root);
    if (active && !active.finishedAt) {
      throw new ProjectTestsError('Ручной прогон по этому проекту уже идёт.');
    }

    const groups = readGroups(root);
    if (request.groupId && !groups.some((group) => group.id === request.groupId)) {
      throw new ProjectTestsNotFoundError(`Группы «${request.groupId}» в проекте нет.`);
    }
    const environments = readEnvironments(root);
    const plan = request.planId ? readPlan(root, request.planId) : undefined;
    if (request.planId && !plan) {
      throw new ProjectTestsNotFoundError(`Плана «${request.planId}» в проекте нет.`);
    }

    const chosen = plan
      ? planCases(groups, plan)
      : selectCases(groups, {
          groupIds: request.groupId ? [request.groupId] : undefined,
        }).filter(
          (item) =>
            !request.caseIds?.length ||
            request.caseIds.includes(item.testCase.id) ||
            request.caseIds.includes(`${item.groupId}:${item.testCase.id}`),
        );

    if (chosen.length === 0) throw new ProjectTestsError('Прогонять нечего: кейсов нет.');

    // Агент переписывает файл группы после каждого кейса; отметки человека в тот
    // же файл либо потерялись бы, либо стёрли его результаты. Замок тот же, что у
    // правок из панели, — маршрут передаёт его сюда, домен реестра прогонов не знает.
    for (const groupId of new Set(chosen.map((item) => item.groupId))) assertUnlocked?.(groupId);

    const points = buildPoints(chosen, environments, {
      plan,
      environmentId: request.environmentId,
    });

    const session: ProjectTestManualSession = {
      runId: randomUUID(),
      planId: plan?.id,
      environmentId: request.environmentId ?? points[0]?.environmentId,
      points,
      index: 0,
      results: [],
      startedAt: now,
    };
    this.sessions.set(root, session);
    this.persist(root, session, 'running');
    return session;
  }

  /** Отметить результат прохода. Пишется сразу: и в кейс, и в историю. */
  record(root: string, input: ProjectTestManualResultInput, now: string): ProjectTestManualSession {
    const session = this.require(root, input.runId);
    const point = session.points.find((item) => item.id === input.pointId);
    if (!point) throw new ProjectTestsNotFoundError('Такого прохода в этом прогоне нет.');

    const previous = session.results.find((item) => item.pointId === input.pointId);
    // Разбор провала считается один раз и уходит в ОБА места: в файл кейса и в
    // результат прохода. Запись прогона состоит из этих результатов, а «чем
    // доказаны провалы» читает именно её — пока разбор был только в кейсе,
    // честно отмеченный красный шаг с заметкой числился «с разбором шага: 0».
    const failure = failureOf(input);
    const result: ProjectTestPointResult = {
      pointId: point.id,
      groupId: point.groupId,
      caseId: point.caseId,
      environmentId: point.environmentId,
      params: point.params,
      status: input.status,
      statusId: input.statusId,
      note: input.note,
      startedAt: previous?.startedAt ?? now,
      finishedAt: now,
      durationMs: input.durationMs ?? previous?.durationMs,
      steps: input.steps,
      attachments: input.attachments,
      failure,
      defects: previous?.defects,
    };

    session.results = previous
      ? session.results.map((item) => (item.pointId === result.pointId ? result : item))
      : [...session.results, result];

    // Статус кейса — это ПОСЛЕДНИЙ результат, поэтому пишем его сразу, а не в
    // конце: человек может закрыть окно на середине прогона, и половина
    // проверенного не должна пропасть.
    applyResults(
      root,
      [
        {
          groupId: result.groupId,
          caseId: result.caseId,
          status: result.status,
          statusId: result.statusId,
          note: result.note,
          failure,
          attachments: result.attachments,
          runId: session.runId,
          at: now,
        },
      ],
      now,
    );

    const next = session.points.findIndex(
      (item) => !session.results.some((done) => done.pointId === item.id),
    );
    session.index = next >= 0 ? next : session.points.length - 1;
    this.persist(root, session, 'running');
    return session;
  }

  /** Завершить прогон: запись закрывается, сессия остаётся показанной. */
  finish(root: string, runId: string, now: string): ProjectTestManualSession {
    const session = this.require(root, runId);
    session.finishedAt = now;
    this.persist(root, session, 'done');
    return session;
  }

  /**
   * Бросить прогон. Отмеченное остаётся — незачем стирать чужую работу.
   *
   * Закрытый прогон здесь только убирается с экрана: его запись уже «done», и
   * переписать её на «stopped» значило бы соврать в истории.
   */
  cancel(root: string, runId: string, now: string): void {
    const session = this.sessions.get(root);
    if (!session || session.runId !== runId) return;
    if (!session.finishedAt) {
      session.finishedAt = now;
      this.persist(root, session, 'stopped');
    }
    this.sessions.delete(root);
  }

  /** Погасить все сессии — вызывается при выходе сервера панели. */
  stopAll(now: string): void {
    for (const [root, session] of this.sessions) {
      if (!session.finishedAt) {
        session.finishedAt = now;
        this.persist(root, session, 'stopped');
      }
    }
    this.sessions.clear();
  }

  private require(root: string, runId: string): ProjectTestManualSession {
    const session = this.sessions.get(root);
    if (!session) throw new ProjectTestsNotFoundError('Ручной прогон не начат.');
    if (session.runId !== runId) throw new ProjectTestsError('Этот прогон уже не идёт.');
    return session;
  }

  /** Запись прогона на диск — та же форма, что у прогонов агента. */
  private persist(
    root: string,
    session: ProjectTestManualSession,
    status: ProjectTestRunRecord['status'],
  ): void {
    const { branch, commit } = gitContext(root);
    const record: ProjectTestRunRecord = {
      id: session.runId,
      mode: 'manual',
      actor: 'human',
      planId: session.planId,
      environmentId: session.environmentId,
      branch,
      commit,
      // Ручной проход тоже попадает в веху: релиз проверяют и руками.
      release: releaseTag(root),
      status,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      results: session.results,
      summary: summarize(session.results),
    };
    writeRun(root, record);
  }
}

/** Сколько проходов осталось — панель показывает это полосой прогресса. */
export function remainingPoints(session: ProjectTestManualSession): ProjectTestPoint[] {
  const done = new Set(session.results.map((item) => item.pointId));
  return session.points.filter((item) => !done.has(item.id));
}

/**
 * Разбор провала из отметок человека: первый красный шаг и его заметка.
 *
 * Агент пишет `failure` сам, тестировщик ставит галочки — и без этого ручной
 * провал в отчёте числился «недоказанным», хотя шаг и причина были отмечены.
 */
function failureOf(input: ProjectTestManualResultInput): ProjectTestFailure | undefined {
  if (input.status !== 'failed' && input.status !== 'blocked') return undefined;
  const red = input.steps?.find((step) => step.status === 'failed' || step.status === 'blocked');
  const actual = red?.note?.trim() || input.note?.trim() || undefined;
  if (!red && !actual) return undefined;
  return { step: red ? red.index + 1 : undefined, actual };
}
