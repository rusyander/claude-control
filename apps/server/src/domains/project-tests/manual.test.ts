import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectTestManualRegistry, remainingPoints } from './manual.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';
import { evidenceOf, readRuns } from './runs-store.ts';
import { savePlan } from './plans.ts';
import { ProjectTestsError, ProjectTestsLockedError, ProjectTestsNotFoundError } from './files.ts';

/**
 * Ручной прогон: кейсы проходит человек, панель записывает.
 *
 * Главное свойство — результат уходит на диск СРАЗУ, а не в конце: закрытая
 * вкладка, выключенная панель или переход на телефон не должны стоить
 * отмеченного. Поэтому проверяется не только состояние сессии в памяти, но и
 * файл кейса, и запись прогона.
 */
describe('project-tests/manual', () => {
  let project = '';
  let manual: ProjectTestManualRegistry;
  const now = '2026-09-07T10:00:00.000Z';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-manual-'));
    manual = new ProjectTestManualRegistry();
    createGroup(project, 'gui', 'GUI');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть'] }, now);
    upsertCase(project, 'gui', { title: 'Выход', steps: ['нажать'] }, now);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('прогон по группе разворачивается в проходы по числу кейсов', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);

    expect(session.points).toHaveLength(2);
    expect(session.index).toBe(0);
    expect(remainingPoints(session)).toHaveLength(2);
  });

  it('отмеченный результат сразу лежит в файле кейса и в истории', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(
      project,
      { runId: session.runId, pointId: point.id, status: 'failed', note: 'кнопка не нажимается' },
      '2026-09-07T10:05:00.000Z',
    );

    const testCase = readGroups(project)[0]?.cases.find((item) => item.id === point.caseId);
    expect(testCase?.status).toBe('failed');
    expect(testCase?.note).toBe('кнопка не нажимается');
    expect(testCase?.lastRunAt).toBe('2026-09-07T10:05:00.000Z');

    const [run] = readRuns(project);
    expect(run?.actor).toBe('human');
    expect(run?.results).toHaveLength(1);
    expect(run?.summary.failed).toBe(1);
  });

  /**
   * Разбор провала обязан лежать И в кейсе, И в записи прогона: «чем доказаны
   * провалы» считает его по записи (`evidenceOf` смотрит `result.failure`), и
   * без этого честно отмеченный красный шаг с заметкой показывался как
   * «с разбором шага: 0».
   */
  it('красный шаг с заметкой виден в доказательствах провала', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(
      project,
      {
        runId: session.runId,
        pointId: point.id,
        status: 'failed',
        note: 'кнопка не нажимается',
        steps: [{ index: 0, status: 'failed', note: 'ничего не происходит' }],
      },
      '2026-09-07T10:05:00.000Z',
    );

    const [run] = readRuns(project);
    expect(run?.results[0]?.failure).toEqual({ step: 1, actual: 'ничего не происходит' });

    const evidence = evidenceOf(readRuns(project), readGroups(project));
    expect(evidence.failed).toBe(1);
    expect(evidence.detailed).toBe(1);
  });

  it('пройденный заново проход теряет прежний разбор провала', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;
    const mark = (status: 'failed' | 'passed', at: string) =>
      manual.record(
        project,
        {
          runId: session.runId,
          pointId: point.id,
          status,
          steps: [{ index: 0, status, note: status === 'failed' ? 'пусто' : undefined }],
        },
        at,
      );

    mark('failed', '2026-09-07T10:05:00.000Z');
    mark('passed', '2026-09-07T10:06:00.000Z');

    expect(readRuns(project)[0]?.results[0]?.failure).toBeUndefined();
    expect(evidenceOf(readRuns(project), readGroups(project)).detailed).toBe(0);
  });

  it('курсор переезжает на первый неотмеченный проход', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);

    const after = manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      now,
    );

    expect(after.index).toBe(1);
    expect(remainingPoints(after)).toHaveLength(1);
  });

  it('повторная отметка того же прохода заменяет результат, а не добавляет второй', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(project, { runId: session.runId, pointId: point.id, status: 'failed' }, now);
    const after = manual.record(
      project,
      { runId: session.runId, pointId: point.id, status: 'passed' },
      '2026-09-07T10:10:00.000Z',
    );

    expect(after.results).toHaveLength(1);
    expect(after.results[0]?.status).toBe('passed');
  });

  it('второй прогон по тому же проекту не начинается — иначе два человека пишут в один файл', () => {
    manual.start(project, { groupId: 'gui' }, now);

    expect(() => manual.start(project, { groupId: 'gui' }, now)).toThrow(ProjectTestsError);
  });

  /**
   * «Завершить» при непройденных проходах: запись знала только отмеченное, и
   * брошенный кейс пропадал из счёта — прогон 6 из 7 читался как полный.
   */
  it('запись прогона помнит, сколько проходов было задумано', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      now,
    );
    manual.finish(project, session.runId, '2026-09-07T11:00:00.000Z');

    const [run] = readRuns(project);
    expect(run?.planned).toBe(2);
    expect(run?.summary.total).toBe(1);
    // Число без имён — полдела: агент панели, прочитав запись, так и ответил —
    // «один кейс остался без результата, какой именно, по данным не видно».
    const open = session.points[1]!;
    expect(run?.unwalked).toEqual([
      { pointId: open.id, groupId: open.groupId, caseId: open.caseId, title: open.title },
    ]);
  });

  it('завершённый прогон отпускает проект', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.finish(project, session.runId, '2026-09-07T11:00:00.000Z');

    expect(manual.get(project)?.finishedAt).toBe('2026-09-07T11:00:00.000Z');
    expect(() => manual.start(project, { groupId: 'gui' }, now)).not.toThrow();
  });

  it('брошенный прогон оставляет отмеченное, но убирает сессию', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      now,
    );
    manual.cancel(project, session.runId, '2026-09-07T11:00:00.000Z');

    expect(manual.get(project)).toBeUndefined();
    expect(readGroups(project)[0]?.cases[0]?.status).toBe('passed');
    expect(readRuns(project)[0]?.status).toBe('stopped');
  });

  /** Сводку убирают той же кнопкой — но история уже закрыта и переписывать её нельзя. */
  it('закрытие сводки не превращает завершённый прогон в брошенный', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.finish(project, session.runId, '2026-09-07T11:00:00.000Z');
    manual.cancel(project, session.runId, '2026-09-07T11:30:00.000Z');

    expect(manual.get(project)).toBeUndefined();
    expect(readRuns(project)[0]?.status).toBe('done');
    expect(readRuns(project)[0]?.finishedAt).toBe('2026-09-07T11:00:00.000Z');
  });

  it('прогон по несуществующему плану — 404, а не пустая сессия', () => {
    expect(() => manual.start(project, { planId: 'missing-plan' }, now)).toThrow(
      ProjectTestsNotFoundError,
    );
  });

  it('прогон по плану берёт его кейсы', () => {
    const plan = savePlan(project, { title: 'Дым', caseIds: ['gui-002'] }, now);

    const session = manual.start(project, { planId: plan.id }, now);

    expect(session.points.map((point) => point.caseId)).toEqual(['gui-002']);
    expect(session.planId).toBe(plan.id);
  });

  it('чужой проход не отмечается', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);

    expect(() =>
      manual.record(project, { runId: session.runId, pointId: 'чужой', status: 'passed' }, now),
    ).toThrow(ProjectTestsNotFoundError);
  });
  /**
   * Панель перезапускается (обновление, dev-watch, перезагрузка машины), а
   * человек посреди прохода. Сессия жила только в памяти: после рестарта
   * кнопка «Ручной проход» открывала пустоту, отметить следующий кейс было
   * нельзя, а запись прогона навсегда оставалась «идёт».
   */
  it('проход переживает перезапуск панели: сессия поднимается с диска и продолжается', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      '2026-09-07T10:05:00.000Z',
    );
    manual.stopAll('2026-09-07T10:06:00.000Z');

    const restarted = new ProjectTestManualRegistry();
    const restored = restarted.get(project);
    expect(restored?.runId).toBe(session.runId);
    expect(restored?.results).toHaveLength(1);
    expect(restored?.index).toBe(1);

    restarted.record(
      project,
      { runId: session.runId, pointId: session.points[1]!.id, status: 'failed', note: 'упало' },
      '2026-09-07T10:10:00.000Z',
    );
    restarted.finish(project, session.runId, '2026-09-07T10:11:00.000Z');
    expect(readRuns(project)[0]?.status).toBe('done');
    expect(readRuns(project)[0]?.summary.failed).toBe(1);
    expect(new ProjectTestManualRegistry().get(project)).toBeUndefined();
  });

  it('запись прохода, чью сессию уже не поднять, закрывается как брошенная, а не висит «идёт»', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    manual.record(
      project,
      { runId: session.runId, pointId: session.points[0]!.id, status: 'passed' },
      '2026-09-07T10:05:00.000Z',
    );
    rmSync(join(project, '.agent', 'tests', 'runs', 'manual.session.json'), { force: true });

    expect(new ProjectTestManualRegistry().get(project)).toBeUndefined();
    const [run] = readRuns(project);
    expect(run?.status).toBe('stopped');
    expect(run?.finishedAt).toBe('2026-09-07T10:05:00.000Z');
  });
});

/** Группы читаются по алфавиту — gui после api, поэтому не [0]. */
const gui = (root: string) => readGroups(root).find((group) => group.id === 'gui')?.cases ?? [];

describe('project-tests/manual: замок группы и доказательства', () => {
  let project = '';
  let manual: ProjectTestManualRegistry;
  const now = '2026-09-08T10:00:00.000Z';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-manual-lock-'));
    manual = new ProjectTestManualRegistry();
    createGroup(project, 'gui', 'GUI');
    createGroup(project, 'api', 'API');
    upsertCase(project, 'gui', { title: 'Вход', steps: ['открыть', 'нажать'] }, now);
    upsertCase(project, 'api', { title: 'Пинг', steps: ['curl'] }, now);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('группу, которую переписывает агент, человек не начинает — сессии нет', () => {
    const locked = (groupId: string) => {
      if (groupId === 'gui') throw new ProjectTestsLockedError('идёт прогон', 'run-1');
    };

    expect(() => manual.start(project, { groupId: 'gui' }, now, locked)).toThrow(
      ProjectTestsLockedError,
    );
    expect(manual.get(project)).toBeUndefined();
    expect(manual.start(project, { groupId: 'api' }, now, locked).points).toHaveLength(1);
  });

  it('отбор принимает форму «группа:кейс» и несуществующую группу отвергает', () => {
    expect(manual.start(project, { caseIds: ['gui:gui-001'] }, now).points).toHaveLength(1);
    manual.cancel(project, manual.get(project)!.runId, now);
    expect(() => manual.start(project, { groupId: 'nope' }, now)).toThrow(
      ProjectTestsNotFoundError,
    );
  });

  it('красный шаг человека становится разбором провала, вложения ложатся в кейс', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(
      project,
      {
        runId: session.runId,
        pointId: point.id,
        status: 'failed',
        note: 'общая заметка',
        steps: [
          { index: 0, status: 'passed' },
          { index: 1, status: 'failed', note: 'кнопка серая' },
        ],
        attachments: ['.agent/tests/attachments/gui-001/shot.png'],
      },
      now,
    );

    const testCase = gui(project).find((item) => item.id === point.caseId);
    expect(testCase?.failure).toEqual({ step: 2, actual: 'кнопка серая' });
    expect(testCase?.attachments).toEqual(['.agent/tests/attachments/gui-001/shot.png']);
  });

  it('провал без отмеченных шагов берёт причину из заметки; зелёный разбора не получает', () => {
    const session = manual.start(project, { groupId: 'gui' }, now);
    const point = session.points[0]!;

    manual.record(
      project,
      { runId: session.runId, pointId: point.id, status: 'failed', note: 'упало' },
      now,
    );
    expect(gui(project)[0]?.failure).toEqual({ step: undefined, actual: 'упало' });

    manual.record(project, { runId: session.runId, pointId: point.id, status: 'passed' }, now);
    expect(gui(project)[0]?.failure).toBeUndefined();
  });

  /**
   * «Шаг / ожидалось / получилось» — три части разбора, а ручной провал нёс
   * только две: ожидание красного шага лежит в самом кейсе, человек его не
   * перепечатывает, и дефект уходил без строки «ожидалось».
   */
  it('красный шаг несёт в разбор своё ожидание — с подставленным параметром', () => {
    upsertCase(
      project,
      'api',
      {
        title: 'Тема',
        parameters: [{ name: 'theme', values: ['light'] }],
        steps: [{ action: 'включить %theme', expected: 'фон %theme' }],
      },
      now,
    );
    const session = manual.start(project, { groupId: 'api' }, now);
    const point = session.points.find((item) => item.params?.theme === 'light')!;

    manual.record(
      project,
      {
        runId: session.runId,
        pointId: point.id,
        status: 'failed',
        steps: [{ index: 0, status: 'failed', note: 'фон не сменился' }],
      },
      now,
    );

    const result = manual.get(project)?.results[0];
    expect(result?.failure).toEqual({ step: 1, expected: 'фон light', actual: 'фон не сменился' });
  });

  /**
   * Параметризованный кейс — несколько проходов. Статус кейса писался по
   * ПОСЛЕДНЕМУ отмеченному, и зелёный второй проход прятал красный первый:
   * в библиотеке кейс «пройден», хотя на одной из тем он упал.
   */
  it('статус параметризованного кейса — худший из его проходов, а не последний', () => {
    upsertCase(
      project,
      'api',
      {
        title: 'Тема',
        parameters: [{ name: 'theme', values: ['light', 'dark'] }],
        steps: [{ action: 'включить %theme' }],
      },
      now,
    );
    const session = manual.start(project, { groupId: 'api' }, now);
    const points = session.points.filter((item) => item.params?.theme);
    const [light, dark] = points;

    manual.record(
      project,
      { runId: session.runId, pointId: light!.id, status: 'failed', note: 'светлая сломана' },
      now,
    );
    manual.record(project, { runId: session.runId, pointId: dark!.id, status: 'passed' }, now);

    const api = readGroups(project).find((group) => group.id === 'api')!;
    const theme = api.cases.find((item) => item.id === light!.caseId);
    expect(theme?.status).toBe('failed');
    expect(theme?.note).toBe('светлая сломана');
    expect(theme?.failure?.actual).toBe('светлая сломана');
  });
});
