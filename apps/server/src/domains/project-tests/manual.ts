import { randomUUID } from 'node:crypto';
import type {
  ProjectTestFailure,
  ProjectTestManualResultInput,
  ProjectTestManualSession,
  ProjectTestPoint,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  ProjectTestUnwalkedPoint,
} from '@agentdeck/contracts';
import { applyParams, expandSteps, summarize } from '@agentdeck/contracts/test-format';
import {
  ProjectTestsError,
  ProjectTestsLockedError,
  ProjectTestsNotFoundError,
  readJson,
  testsPath,
  writeJson,
} from './files.ts';
import { applyResults, readGroups, selectCases } from './store.ts';
import { readEnvironments, readSharedSteps } from './library.ts';
import { buildPoints, planCases, readPlan } from './plans.ts';
import { gitContext, releaseTag } from './impact.ts';
import { readRun, readRuns, writeRun } from './runs-store.ts';
import { coded } from '../../lib/server-text.ts';
import { removeEntry } from '../../lib/safe-io.ts';

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
  /** Проекты, чью сессию уже пробовали поднять с диска в этом процессе. */
  private readonly restored = new Set<string>();

  /**
   * Идущая сессия проекта.
   *
   * После перезапуска панели память пуста, а человек посреди прохода: сессия
   * поднимается из `runs/manual.session.json`. Без этого рестарт (обновление,
   * dev-watch, перезагрузка) обрывал проход — отметить следующий кейс было
   * нельзя, а запись прогона навсегда оставалась «идёт».
   */
  get(projectPath: string): ProjectTestManualSession | undefined {
    const live = this.sessions.get(projectPath);
    if (this.restored.has(projectPath)) return live;
    const session = live ?? restoreSession(projectPath);
    if (session && !live) this.sessions.set(projectPath, session);
    // «Поднят» — только когда закрытие брошенных записей прошло: упало (EPERM
    // от антивируса) — следующий get() попробует снова. Раньше отметка стояла
    // до подъёма, и сбой терял идущую сессию до конца процесса (F-352).
    if (closeAbandoned(projectPath, session?.runId)) this.restored.add(projectPath);
    return session;
  }

  /** Начать ручной прогон по плану, группе или отобранным кейсам. */
  start(
    root: string,
    request: { planId?: string; groupId?: string; caseIds?: string[]; environmentId?: string },
    now: string,
    assertUnlocked?: (groupId: string) => void,
  ): ProjectTestManualSession {
    const active = this.get(root);
    if (active && !active.finishedAt) {
      // Как у прогона агента: занято — 409 с id идущего прохода.
      throw coded(
        new ProjectTestsLockedError('Ручной прогон по этому проекту уже идёт.', active.runId),
        'manual-already-running',
      );
    }

    const groups = readGroups(root);
    if (request.groupId && !groups.some((group) => group.id === request.groupId)) {
      throw coded(
        new ProjectTestsNotFoundError(`Группы «${request.groupId}» в проекте нет.`),
        'run-group-not-found',
        { groupId: request.groupId },
      );
    }
    const environments = readEnvironments(root);
    const plan = request.planId ? readPlan(root, request.planId) : undefined;
    if (request.planId && !plan) {
      throw coded(
        new ProjectTestsNotFoundError(`Плана «${request.planId}» в проекте нет.`),
        'run-plan-not-found',
        { planId: request.planId },
      );
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

    if (chosen.length === 0)
      throw coded(new ProjectTestsError('Прогонять нечего: кейсов нет.'), 'run-no-cases');

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
    if (!point)
      throw coded(
        new ProjectTestsNotFoundError('Такого прохода в этом прогоне нет.'),
        'manual-point-not-found',
      );

    const previous = session.results.find((item) => item.pointId === input.pointId);
    // Разбор провала считается один раз и уходит в ОБА места: в файл кейса и в
    // результат прохода. Запись прогона состоит из этих результатов, а «чем
    // доказаны провалы» читает именно её — пока разбор был только в кейсе,
    // честно отмеченный красный шаг с заметкой числился «с разбором шага: 0».
    const failure = failureOf(input, expectedOf(root, point));
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

    // Статус кейса пишем сразу, а не в конце: человек может закрыть окно на
    // середине прогона, и половина проверенного не должна пропасть. У кейса с
    // параметрами проходов несколько, и статус — ХУДШИЙ из них в этом прогоне:
    // по последнему зелёный второй проход прятал красный первый.
    const decisive = worstOf(
      session.results.filter(
        (item) => item.groupId === result.groupId && item.caseId === result.caseId,
      ),
    );
    applyResults(
      root,
      [
        {
          groupId: result.groupId,
          caseId: result.caseId,
          status: decisive.status,
          statusId: decisive.statusId,
          note: decisive.note,
          failure: decisive.failure,
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
    const session = this.get(root);
    if (!session || session.runId !== runId) return;
    if (!session.finishedAt) {
      session.finishedAt = now;
      this.persist(root, session, 'stopped');
    }
    this.sessions.delete(root);
  }

  /**
   * Выход сервера панели: идущий проход НЕ бросается. Его сессия уже на диске,
   * и следующий запуск панели поднимет её — человек продолжит с того же кейса,
   * а не начнёт заново. Параметр времени оставлен ради прежней подписи.
   */
  stopAll(_now: string): void {
    this.sessions.clear();
    this.restored.clear();
  }

  private require(root: string, runId: string): ProjectTestManualSession {
    const session = this.get(root);
    if (!session)
      throw coded(new ProjectTestsNotFoundError('Ручной прогон не начат.'), 'manual-not-started');
    if (session.runId !== runId)
      throw coded(new ProjectTestsError('Этот прогон уже не идёт.'), 'manual-run-over');
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
      planned: session.points.length,
      unwalked: unwalkedOf(session),
    };
    writeRun(root, record);
    // Сессия лежит рядом с записью, пока проход идёт: по ней рестарт панели
    // продолжает его. Закрытому проходу поднимать нечего — файл убирается.
    if (status === 'running') writeJson(root, SESSION_FILE, session);
    // Поштучное удаление, не rmSync: на путях не латиницей тот рапортует успех,
    // оставляя файл (.claude/gotchas.md, «Windows filesystem»), — а забытая
    // сессия воскресила бы закрытый проход при следующем старте.
    else {
      try {
        removeEntry(testsPath(root, SESSION_FILE));
      } catch {
        // Запись уже закрыта; EBUSY на удалении — не ошибка завершения:
        // оставшийся файл при подъёме сверяется с записью и не воскрешает
        // законченный проход (F-353).
      }
    }
  }
}

/** Идущая ручная сессия проекта на диске — одна, как и в памяти. */
const SESSION_FILE = 'runs/manual.session.json';

/**
 * Поднять идущую сессию с диска после перезапуска панели.
 *
 * Заодно закрываются записи ручных прогонов, которые остались «идёт» без
 * сессии (панель погасла до этой правки или файл сессии потерян): продолжить
 * их нельзя, а «идёт» в истории — неправда, которая к тому же никогда не
 * кончится. Закрываются как брошенные, временем последней отметки.
 */
function restoreSession(root: string): ProjectTestManualSession | undefined {
  const session = parseSession(readJson(root, SESSION_FILE).data);
  if (!session) return undefined;
  // Файл сессии, чья запись уже закрыта (удаление после «done» не удалось), —
  // остаток, а не идущий проход.
  const record = readRun(root, session.runId);
  return record && record.status !== 'running' ? undefined : session;
}

/** Закрыть брошенные записи; false — запись не удалась, попробовать позже. */
function closeAbandoned(root: string, liveRunId: string | undefined): boolean {
  try {
    for (const run of readRuns(root, 200)) {
      if (run.mode !== 'manual' || run.status !== 'running' || run.id === liveRunId) continue;
      const last = run.results
        .map((item) => item.finishedAt ?? '')
        .sort()
        .at(-1);
      writeRun(root, { ...run, status: 'stopped', finishedAt: last || run.startedAt });
    }
    return true;
  } catch {
    return false;
  }
}

/** Разбор файла сессии: битый или чужой файл — сессии нет, а не исключение. */
function parseSession(data: unknown): ProjectTestManualSession | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const session = data as Partial<ProjectTestManualSession>;
  if (typeof session.runId !== 'string' || typeof session.startedAt !== 'string') return undefined;
  if (!Array.isArray(session.points) || session.finishedAt) return undefined;
  return {
    ...session,
    runId: session.runId,
    startedAt: session.startedAt,
    points: session.points,
    results: Array.isArray(session.results) ? session.results : [],
    index: typeof session.index === 'number' ? session.index : 0,
  };
}

/** Непройденные проходы именами — для записи; пусто — поля нет. */
function unwalkedOf(session: ProjectTestManualSession): ProjectTestUnwalkedPoint[] | undefined {
  const open = remainingPoints(session).map((point) => ({
    pointId: point.id,
    groupId: point.groupId,
    caseId: point.caseId,
    title: point.title,
    ...(point.params && Object.keys(point.params).length > 0 ? { params: point.params } : {}),
  }));
  return open.length > 0 ? open : undefined;
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
function failureOf(
  input: ProjectTestManualResultInput,
  expected: (index: number) => string | undefined,
): ProjectTestFailure | undefined {
  if (input.status !== 'failed' && input.status !== 'blocked') return undefined;
  const red = input.steps?.find((step) => step.status === 'failed' || step.status === 'blocked');
  const actual = red?.note?.trim() || input.note?.trim() || undefined;
  if (!red && !actual) return undefined;
  const wanted = red ? expected(red.index) : undefined;
  return { step: red ? red.index + 1 : undefined, ...(wanted ? { expected: wanted } : {}), actual };
}

/**
 * Ожидание шага прохода так, как его видел человек: общие шаги раскрыты,
 * параметры подставлены. Номер шага в отметке считается по раскрытому списку —
 * тому же, что рисует пульт.
 */
function expectedOf(root: string, point: ProjectTestPoint): (index: number) => string | undefined {
  return (index) => {
    const testCase = readGroups(root)
      .find((group) => group.id === point.groupId)
      ?.cases.find((item) => item.id === point.caseId);
    if (!testCase) return undefined;
    const step = expandSteps(testCase.steps, readSharedSteps(root))[index];
    return step?.expected ? applyParams(step.expected, point.params ?? {}) : undefined;
  };
}

/** Чем тяжелее исход, тем раньше он решает статус кейса. */
const SEVERITY: Record<string, number> = { failed: 4, blocked: 3, skipped: 2, passed: 1 };

/** Решающий проход кейса: худший, при равенстве — последний отмеченный. */
function worstOf(results: ProjectTestPointResult[]): ProjectTestPointResult {
  return results.reduce((worst, item) =>
    (SEVERITY[item.status] ?? 0) >= (SEVERITY[worst.status] ?? 0) ? item : worst,
  );
}
