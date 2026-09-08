import type { ProjectTestCase, ProjectTestGroup } from '@agentdeck/contracts';
import { describe, expect, it } from 'vitest';
import { lintLibrary } from './lint.ts';

/**
 * Линтер библиотеки. Главные свойства, которые здесь и проверяются: каждое
 * правило срабатывает на своём кейсе и молчит на здоровом, отчёт называет
 * существующее массовое действие, и линтер НИЧЕГО не меняет — правит только
 * человек кнопкой.
 */

const NOW = '2026-09-08T12:00:00.000Z';

/** Кейс без единого замечания — от него отсчитываются все остальные. */
function healthy(over: Partial<ProjectTestCase> = {}): ProjectTestCase {
  return {
    id: 'gui-001',
    type: 'case',
    title: 'Вход с верным паролем',
    steps: [
      { action: 'Открыть форму входа', expected: 'Видна форма входа' },
      { action: 'Ввести логин и пароль, нажать «Войти»', expected: 'Открылся раздел «Обзор»' },
    ],
    oracle: 'В шапке видно имя вошедшего пользователя',
    priority: 'high',
    readiness: 'ready',
    codePaths: ['apps/web/src/pages/Login'],
    status: 'passed',
    source: 'human',
    lastRunAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over,
  };
}

/** Кейс, у которого не заполнено ничего, кроме обязательного. */
function bare(over: Partial<ProjectTestCase> = {}): ProjectTestCase {
  return {
    id: 'gui-002',
    type: 'case',
    title: 'Черновик без ничего',
    steps: [{ action: 'Открыть панель' }],
    status: 'unknown',
    source: 'agent',
    ...over,
  };
}

function group(cases: ProjectTestCase[], id = 'gui'): ProjectTestGroup {
  return { id, title: id.toUpperCase(), file: `.agent/tests/${id}.tests.json`, cases };
}

/** Правила, сработавшие на одном кейсе. */
function rulesFor(groups: ProjectTestGroup[], caseId: string): string[] {
  return lintLibrary(groups, { now: NOW })
    .findings.filter((item) => item.caseId === caseId)
    .map((item) => item.rule)
    .sort();
}

describe('project-tests/lint: здоровый набор', () => {
  it('полностью заполненный кейс замечаний не даёт', () => {
    const report = lintLibrary([group([healthy()])], { now: NOW });

    expect(report.findings).toEqual([]);
    expect(report.byRule).toEqual([]);
    expect(report.checked).toBe(1);
    // Момент отчёта — заданный, а не календарь машины: иначе отчёт не повторить.
    expect(report.checkedAt).toBe(NOW);
  });

  it('архивные кейсы не проверяются и в счёт не идут', () => {
    const report = lintLibrary([group([healthy(), bare({ archived: true })])], { now: NOW });

    expect(report.checked).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('нечитаемая группа пропускается целиком', () => {
    const broken: ProjectTestGroup = { ...group([bare()]), error: 'Битый файл' };

    expect(lintLibrary([broken], { now: NOW })).toMatchObject({ findings: [], checked: 0 });
  });
});

describe('project-tests/lint: правила описания', () => {
  it('кейс без способа проверки', () => {
    expect(rulesFor([group([healthy({ oracle: undefined })])], 'gui-001')).toEqual(['no-oracle']);
  });

  it('чек-лист про способ проверки не спрашивают — у него его и не бывает', () => {
    const checklist = healthy({
      id: 'gui-003',
      type: 'checklist',
      oracle: undefined,
      steps: [{ action: 'Пройти по всем разделам' }],
    });

    expect(rulesFor([group([checklist])], 'gui-003')).toEqual([]);
  });

  it('шаг без ожидания, с номером первого такого', () => {
    const blind = healthy({
      steps: [
        { action: 'Открыть форму входа', expected: 'Видна форма' },
        { action: 'Ввести логин' },
        { action: 'Нажать «Войти»' },
      ],
    });
    const report = lintLibrary([group([blind])], { now: NOW });

    expect(report.findings.map((item) => item.rule)).toEqual(['step-without-expected']);
    expect(report.findings[0]?.message).toContain('2');
  });

  it('чек-лист с ожиданием: либо оно лишнее, либо это кейс', () => {
    const checklist = healthy({
      id: 'gui-004',
      type: 'checklist',
      oracle: undefined,
      steps: [{ action: 'Пройти по разделам', expected: 'Все открылись' }],
    });

    expect(rulesFor([group([checklist])], 'gui-004')).toEqual(['checklist-with-expected']);
  });

  it('нет привязки к коду — кейс выпадет из отбора по диффу', () => {
    expect(rulesFor([group([healthy({ codePaths: [] })])], 'gui-001')).toEqual(['no-code-paths']);
  });

  it('нет приоритета, и чинится это существующим массовым действием', () => {
    const report = lintLibrary([group([healthy({ priority: undefined })])], { now: NOW });

    expect(report.findings[0]?.rule).toBe('no-priority');
    expect(report.findings[0]?.fix).toEqual({
      action: 'priority',
      value: 'medium',
      label: 'Проставить приоритет «средний»',
    });
  });

  it('сценарий длиннее пятнадцати шагов', () => {
    const long = healthy({
      steps: Array.from({ length: 16 }, (_, index) => ({
        action: `Шаг ${index + 1}`,
        expected: `Получилось ${index + 1}`,
      })),
    });

    expect(rulesFor([group([long])], 'gui-001')).toEqual(['too-many-steps']);
    expect(lintLibrary([group([long])], { now: NOW, maxSteps: 20 }).findings).toEqual([]);
  });
});

describe('project-tests/lint: правила параметров', () => {
  it('параметр в шагах не объявлен — подставлять нечего, и это ошибка', () => {
    const withParam = healthy({
      steps: [{ action: 'Ввести %login и пароль', expected: 'Открылся раздел' }],
    });
    const report = lintLibrary([group([withParam])], { now: NOW });

    expect(report.findings.map((item) => item.rule)).toEqual(['undeclared-parameter']);
    expect(report.findings[0]?.severity).toBe('error');
    expect(report.findings[0]?.message).toContain('%login');
  });

  it('объявленный параметр, которого нет в тексте, размножает прогон впустую', () => {
    const unused = healthy({ parameters: [{ name: 'role', values: ['админ', 'гость'] }] });

    expect(rulesFor([group([unused])], 'gui-001')).toEqual(['unused-parameter']);
  });

  it('параметр из предусловия объявленным впустую не считается', () => {
    const inPrecondition = healthy({
      precondition: 'Пользователь %role уже заведён',
      parameters: [{ name: 'role', values: ['админ'] }],
    });

    expect(rulesFor([group([inPrecondition])], 'gui-001')).toEqual([]);
  });
});

describe('project-tests/lint: правила состояния', () => {
  it('устаревший кейс вне архива', () => {
    const report = lintLibrary([group([healthy({ readiness: 'obsolete' })])], { now: NOW });

    expect(report.findings.map((item) => item.rule)).toEqual(['obsolete-not-archived']);
    expect(report.findings[0]?.fix).toEqual({ action: 'archive', label: 'Убрать в архив' });
  });

  it('черновик старше тридцати дней', () => {
    const stale = healthy({ readiness: 'draft', updatedAt: '2026-07-01T10:00:00.000Z' });
    const report = lintLibrary([group([stale])], { now: NOW });

    expect(report.findings.map((item) => item.rule)).toEqual(['stale-draft']);
    expect(report.findings[0]?.fix?.action).toBe('readiness');
    // Свежий черновик замечанием не считается: он на то и черновик.
    expect(
      lintLibrary(
        [group([healthy({ readiness: 'draft', updatedAt: '2026-09-05T10:00:00.000Z' })])],
        {
          now: NOW,
        },
      ).findings,
    ).toEqual([]);
  });

  it('кейс не гонялся дольше порога, а без отметки — не гонялся ни разу', () => {
    const old = healthy({ lastRunAt: '2026-01-10T10:00:00.000Z' });
    const never = healthy({ id: 'gui-005', lastRunAt: undefined });

    expect(rulesFor([group([old])], 'gui-001')).toEqual(['not-run']);
    expect(lintLibrary([group([old])], { now: NOW }).findings[0]?.message).toContain('дней');
    expect(rulesFor([group([never])], 'gui-005')).toEqual(['not-run']);
    expect(lintLibrary([group([never])], { now: NOW }).findings[0]?.message).toContain('Ни разу');
    // Порог свой у проекта: с ним же кейс замечанием быть перестаёт.
    expect(lintLibrary([group([old])], { now: NOW, notRunDays: 365 }).findings).toEqual([]);
  });
});

describe('project-tests/lint: повторы и дубли', () => {
  it('повтор заголовка вешается на копию, а не на оригинал', () => {
    const original = healthy();
    const copy = healthy({ id: 'gui-006', title: '  вход с ВЕРНЫМ паролем ' });
    const report = lintLibrary([group([original, copy])], { now: NOW });
    const titles = report.findings.filter((item) => item.rule === 'duplicate-title');

    expect(titles.map((item) => item.caseId)).toEqual(['gui-006']);
    expect(titles[0]?.message).toContain('gui-001');
    expect(titles[0]?.fix).toEqual({ action: 'archive', label: 'Убрать повтор в архив' });
  });

  it('одинаковый заголовок в РАЗНЫХ группах повтором не считается', () => {
    const report = lintLibrary([group([healthy()]), group([healthy({ id: 'e2e-001' })], 'e2e')], {
      now: NOW,
    });

    expect(report.findings.filter((item) => item.rule === 'duplicate-title')).toEqual([]);
  });

  it('похожие кейсы едут в отчёт отдельным разделом', () => {
    const first = healthy({
      id: 'gui-010',
      title: 'Вход с пустым паролем',
      steps: [
        { action: 'Открыть форму входа', expected: 'Поля логина и пароля пустые' },
        { action: 'Ввести логин, пароль оставить пустым', expected: 'Кнопка «Войти» неактивна' },
      ],
    });
    const second = healthy({
      id: 'gui-011',
      title: 'Вход с пустым полем пароля',
      steps: [
        { action: 'Открыть форму входа', expected: 'Видны поля логина и пароля' },
        { action: 'Ввести логин и оставить пароль пустым', expected: 'Кнопка «Войти» неактивна' },
      ],
    });

    const report = lintLibrary([group([first, second])], { now: NOW });

    expect(report.duplicates.map((item) => item.caseId)).toEqual(['gui-010', 'gui-011']);
    expect(report.duplicates[0]?.similar[0]?.caseId).toBe('gui-011');
  });
});

describe('project-tests/lint: отчёт', () => {
  it('свод по правилам считает кейсы и ставит серьёзные наверх', () => {
    const noPriority = healthy({ id: 'gui-020', priority: undefined });
    const alsoNoPriority = healthy({ id: 'gui-021', priority: undefined, title: 'Выход' });
    const broken = healthy({
      id: 'gui-022',
      title: 'Оплата',
      steps: [{ action: 'Ввести %card', expected: 'Карта принята' }],
    });

    const report = lintLibrary([group([noPriority, alsoNoPriority, broken])], { now: NOW });

    expect(report.byRule).toEqual([
      { rule: 'undeclared-parameter', severity: 'error', title: 'Параметр не объявлен', count: 1 },
      { rule: 'no-priority', severity: 'warning', title: 'Нет приоритета', count: 2 },
    ]);
    // Ошибки идут первыми и в самом списке замечаний.
    expect(report.findings[0]?.rule).toBe('undeclared-parameter');
    expect(report.checked).toBe(3);
  });

  it('линтер ничего не правит: набор после проверки байт в байт прежний', () => {
    const groups = [
      group([
        healthy({ oracle: undefined, priority: undefined, codePaths: [] }),
        healthy({ id: 'gui-030', readiness: 'obsolete', lastRunAt: undefined }),
      ]),
    ];
    const before = structuredClone(groups);

    lintLibrary(groups, { now: NOW });

    expect(groups).toEqual(before);
  });
});
