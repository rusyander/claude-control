import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  applyResults,
  bulkCases,
  createGroup,
  readGroups,
  removeCase,
  removeGroup,
  resetStatuses,
  upsertCase,
} from './store.ts';
import { saveSharedStep } from './library.ts';

/**
 * Хранилище кейсов. Проверяется ровно то, ради чего оно написано отдельно от
 * простого `readJsonFile`: файл пишут двое, и чужая запись не должна ни ронять
 * список, ни быть молча затёртой.
 */
const NOW = '2026-08-09T10:00:00.000Z';

/** Первая группа проекта. Отдельной функцией — иначе каждая проверка тонет в `?.`. */
function only(root: string) {
  const [group] = readGroups(root);
  if (!group) throw new Error('групп нет');
  return group;
}

function writeGroupFile(root: string, id: string, body: unknown): void {
  const dir = join(root, '.agent', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.tests.json`),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2),
  );
}

describe('project-tests store', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('в проекте без тестов групп нет', () => {
    expect(readGroups(root)).toEqual([]);
  });

  it('заводит группу и кладёт её файлом в .agent/tests', () => {
    const group = createGroup(root, 'gui');

    expect(group.file).toBe('.agent/tests/gui.tests.json');
    expect(readGroups(root)).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(root, '.agent', 'tests', 'gui.tests.json'), 'utf8')),
    ).toMatchObject({ version: 1, cases: [] });
  });

  it('сломанный файл гасит СВОЮ вкладку и остаётся на диске нетронутым', () => {
    writeGroupFile(root, 'gui', '{ это не json');
    createGroup(root, 'e2e');

    const groups = readGroups(root);
    const gui = groups.find((group) => group.id === 'gui');
    const e2e = groups.find((group) => group.id === 'e2e');

    expect(gui?.error).toBeTruthy();
    expect(gui?.cases).toEqual([]);
    // Соседняя группа работает — одна порча не гасит весь раздел.
    expect(e2e?.error).toBeUndefined();
    // Файл не перезаписан: за сломанным JSON стоит чья-то работа.
    expect(readFileSync(join(root, '.agent', 'tests', 'gui.tests.json'), 'utf8')).toBe(
      '{ это не json',
    );
  });

  it('не пишет поверх сломанного файла даже по прямой правке', () => {
    writeGroupFile(root, 'gui', '{ сломано');

    expect(() => upsertCase(root, 'gui', { title: 'Новый', steps: [] }, NOW)).toThrow(
      ProjectTestsError,
    );
  });

  it('чинит небрежность агента: шаги строкой, статус словом, пустой id', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [{ title: 'Открыть чат', steps: 'зайти\nнажать', status: 'ok' }],
    });

    // Шаги старой формы (строками) достраиваются до объектов: панель и агент
    // пишут действие и ожидание раздельно, а старые файлы должны читаться.
    expect(only(root).cases[0]).toMatchObject({
      id: 'case-1',
      steps: [{ action: 'зайти' }, { action: 'нажать' }],
      // `ok` — то же «прошёл»: терять чужой результат из-за синонима нельзя.
      status: 'passed',
      source: 'agent',
    });
  });

  it('разводит одинаковые id — иначе правка уходила бы не в тот кейс', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [
        { id: 'gui-001', title: 'Первый' },
        { id: 'gui-001', title: 'Второй' },
      ],
    });

    expect(only(root).cases.map((item) => item.id)).toEqual(['gui-001', 'gui-001-2']);
  });

  it('созданный человеком кейс помечен человеческим — агенту его удалять запрещено', () => {
    createGroup(root, 'gui');
    const added = upsertCase(root, 'gui', { title: 'Отправить сообщение', steps: ['нажать'] }, NOW);

    expect(added).toMatchObject({ id: 'gui-001', source: 'human', status: 'unknown' });
    expect(only(root).cases).toHaveLength(1);
  });

  it('правка по id меняет кейс, а не добавляет второй', () => {
    createGroup(root, 'gui');
    const added = upsertCase(root, 'gui', { title: 'Было', steps: [] }, NOW);
    upsertCase(root, 'gui', { id: added.id, title: 'Стало', steps: ['шаг'] }, NOW);

    const cases = only(root).cases;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ title: 'Стало', steps: [{ action: 'шаг' }] });
  });

  it('правка несуществующего кейса — ошибка, а не тихое создание', () => {
    createGroup(root, 'gui');

    expect(() => upsertCase(root, 'gui', { id: 'нет-такого', title: 'X', steps: [] }, NOW)).toThrow(
      ProjectTestsError,
    );
  });

  it('удаляет кейс и группу', () => {
    createGroup(root, 'gui');
    const added = upsertCase(root, 'gui', { title: 'Тест', steps: [] }, NOW);

    removeCase(root, 'gui', added.id);
    expect(only(root).cases).toEqual([]);

    removeGroup(root, 'gui');
    expect(readGroups(root)).toEqual([]);
  });

  it('полный перетест обнуляет галочки — иначе старое «пройдено» сойдёт за новое', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [
        { id: 'gui-001', title: 'A', status: 'passed', note: 'ок', lastRunAt: NOW },
        { id: 'gui-002', title: 'B', status: 'failed' },
      ],
    });

    resetStatuses(root, 'gui');

    expect(only(root).cases.map((item) => item.status)).toEqual(['unknown', 'unknown']);
    expect(only(root).cases[0]?.note).toBeUndefined();
  });

  it('перетест выбранных кейсов не трогает остальные', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [
        { id: 'gui-001', title: 'A', status: 'passed' },
        { id: 'gui-002', title: 'B', status: 'passed' },
      ],
    });

    resetStatuses(root, 'gui', ['gui-002']);

    expect(only(root).cases.map((item) => item.status)).toEqual(['passed', 'unknown']);
  });

  /**
   * Разбор провала. Пишет его агент руками, поэтому «шаг 3» строкой встречается
   * не реже числа, а половина разбора полезнее выброшенного целиком провала.
   */
  it('разбор провала читается даже написанный небрежно', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [
        {
          id: 'gui-001',
          title: 'A',
          status: 'failed',
          failure: {
            step: 'шаг 3',
            expected: 'кнопка выключена',
            actual: 'кнопка активна',
            retry: 'confirmed',
          },
        },
        { id: 'gui-002', title: 'B', status: 'failed', failure: { retry: 'чепуха' } },
      ],
    });

    const cases = only(root).cases;
    expect(cases[0]?.failure).toEqual({
      step: 3,
      expected: 'кнопка выключена',
      actual: 'кнопка активна',
      retry: 'confirmed',
      retryNote: undefined,
    });
    // Разбор, в котором не осталось ни одного понятного поля, — это не разбор.
    expect(cases[1]?.failure).toBeUndefined();
  });

  it('разбор провала принадлежит прогону: правка описания его не стирает', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [
        {
          id: 'gui-001',
          title: 'A',
          status: 'failed',
          failure: { step: 2, actual: 'пусто' },
        },
      ],
    });

    upsertCase(root, 'gui', { id: 'gui-001', title: 'A с уточнением' }, NOW);

    expect(only(root).cases[0]?.failure).toMatchObject({ step: 2, actual: 'пусто' });
  });

  it('позеленевший кейс теряет разбор провала: доказывать больше нечего', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [
        { id: 'gui-001', title: 'A', status: 'failed', failure: { step: 2 } },
        { id: 'gui-002', title: 'B', status: 'failed', failure: { step: 5 } },
      ],
    });

    applyResults(
      root,
      [
        { groupId: 'gui', caseId: 'gui-001', status: 'passed' },
        { groupId: 'gui', caseId: 'gui-002', status: 'failed' },
      ],
      NOW,
    );

    const cases = only(root).cases;
    expect(cases[0]?.failure).toBeUndefined();
    expect(cases[1]?.failure).toMatchObject({ step: 5 });
  });

  it('перетест снимает и разбор провала вместе с галочкой', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [{ id: 'gui-001', title: 'A', status: 'failed', failure: { step: 1 } }],
    });

    resetStatuses(root, 'gui');

    expect(only(root).cases[0]?.failure).toBeUndefined();
  });

  it('имя группы за пределами разрешённого отклоняется — это имя файла', () => {
    expect(() => createGroup(root, '../../etc')).toThrow(ProjectTestsError);
    expect(() => createGroup(root, 'ГУИ')).toThrow(ProjectTestsError);
  });

  /**
   * Встречная запись. Между тем, как панель показала список, и тем, как человек
   * нажал «Сохранить», проходят минуты — и всё это время в тот же файл пишет
   * агент. Здесь это воспроизведено буквально: запись агента вклинивается между
   * чтением и сохранением, и ни одна сторона не должна потерять своё.
   */
  describe('встречная запись панели и агента', () => {
    it('результат прогона переживает сохранение описания', () => {
      writeGroupFile(root, 'gui', {
        version: 1,
        cases: [{ id: 'gui-001', title: 'Отправка', steps: ['открыть'] }],
      });
      // Панель показала список; человек открыл форму.
      expect(only(root).cases[0]?.status).toBe('unknown');

      // Пока форма открыта, агент прошёл кейс и переписал файл целиком.
      writeGroupFile(root, 'gui', {
        version: 1,
        cases: [
          {
            id: 'gui-001',
            title: 'Отправка',
            steps: ['открыть'],
            status: 'failed',
            note: 'кнопка не нажимается',
            lastRunAt: '2026-08-09T11:00:00.000Z',
            lastRunId: 'run-7',
            attachments: ['.agent/tests/attachments/gui-001/shot.png'],
            defects: [{ url: 'https://jira/ABC-1', title: 'Кнопка мертва' }],
          },
        ],
      });

      // Человек сохраняет ТОЛЬКО описание: про результат форма не знает вовсе.
      upsertCase(root, 'gui', { id: 'gui-001', title: 'Отправка сообщения' }, NOW);

      const saved = only(root).cases[0];
      expect(saved).toMatchObject({
        title: 'Отправка сообщения',
        status: 'failed',
        note: 'кнопка не нажимается',
        lastRunAt: '2026-08-09T11:00:00.000Z',
        lastRunId: 'run-7',
      });
      expect(saved?.attachments).toEqual(['.agent/tests/attachments/gui-001/shot.png']);
      expect(saved?.defects).toEqual([{ url: 'https://jira/ABC-1', title: 'Кнопка мертва' }]);
    });

    it('кейс, заведённый агентом между чтением и сохранением, не исчезает', () => {
      createGroup(root, 'gui');
      const mine = upsertCase(root, 'gui', { title: 'Мой кейс', steps: [] }, NOW);

      // Агент дописал в файл свой кейс — панель о нём ещё не знает.
      writeGroupFile(root, 'gui', {
        version: 1,
        cases: [
          { id: mine.id, title: 'Мой кейс' },
          { id: 'gui-777', title: 'Кейс агента', status: 'passed' },
        ],
      });

      upsertCase(root, 'gui', { id: mine.id, title: 'Мой кейс, поправленный' }, NOW);

      // Сохранение по `id` сводится с диском, а не заменяет файл видом панели.
      expect(only(root).cases.map((item) => item.id)).toEqual([mine.id, 'gui-777']);
      expect(only(root).cases[1]?.status).toBe('passed');
    });

    it('поля, которых в запросе нет, берутся с диска, а явно пустые — стираются', () => {
      writeGroupFile(root, 'gui', {
        version: 1,
        cases: [
          {
            id: 'gui-001',
            title: 'Кейс',
            area: 'Чат',
            priority: 'high',
            tags: ['smoke', 'регресс'],
            codePaths: ['apps/web/src/pages/Chat'],
          },
        ],
      });

      upsertCase(root, 'gui', { id: 'gui-001', title: 'Кейс' }, NOW);
      expect(only(root).cases[0]).toMatchObject({
        area: 'Чат',
        priority: 'high',
        tags: ['smoke', 'регресс'],
      });

      // Пустой список — это «очисти», а не «не трогай»: иначе снять тег было бы нечем.
      upsertCase(root, 'gui', { id: 'gui-001', title: 'Кейс', tags: [] }, NOW);
      expect(only(root).cases[0]?.tags).toBeUndefined();
      expect(only(root).cases[0]?.codePaths).toEqual(['apps/web/src/pages/Chat']);
    });

    it('порог сравнения скриншотов читается долей, а чужая опечатка отбрасывается', () => {
      writeGroupFile(root, 'gui', {
        version: 1,
        cases: [
          { id: 'gui-001', title: 'Свой порог', maxDiffRatio: 0.03 },
          { id: 'gui-002', title: 'Проценты по ошибке', maxDiffRatio: 30 },
        ],
      });

      const cases = only(root).cases;

      expect(cases[0]?.maxDiffRatio).toBe(0.03);
      // 30 — это не доля: лучше общий порог, чем «сойдётся что угодно».
      expect(cases[1]?.maxDiffRatio).toBeUndefined();
    });
  });
});

/**
 * Строгость на входе. Каждая из этих проверок — бывший тихий провал, найденный
 * живым прогоном API 08.09: запрос с опечаткой отвечал 200 и либо ничего не
 * делал, либо делал не то, что просили.
 */
describe('project-tests store: строгость на входе', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-strict-'));
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'Вход', steps: ['открыть'], priority: 'high' }, NOW);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('кейс в несуществующую группу — 404, а не новый файл группы', () => {
    expect(() => upsertCase(root, 'nope', { title: 'X', steps: [] }, NOW)).toThrow(
      ProjectTestsNotFoundError,
    );
    expect(readGroups(root).map((group) => group.id)).toEqual(['gui']);
  });

  it('удаление несуществующего кейса — 404 с именем, а не молчаливый успех', () => {
    expect(() => removeCase(root, 'gui', 'gui-999')).toThrow(/gui-999/);
    expect(() => removeCase(root, 'nope', 'gui-001')).toThrow(ProjectTestsNotFoundError);
  });

  it('ссылка на неизвестный общий шаг отклоняется — при прогоне он раскрылся бы в пустоту', () => {
    saveSharedStep(root, { id: 'login', title: 'Войти', steps: ['ввести пароль'] }, NOW);

    expect(() =>
      upsertCase(root, 'gui', { title: 'Y', steps: [{ action: 'выйти', ref: 'logout' }] }, NOW),
    ).toThrow(/logout/);
    expect(() =>
      upsertCase(root, 'gui', { title: 'Y', steps: [{ action: 'войти', ref: 'login' }] }, NOW),
    ).not.toThrow();
  });

  it('неизвестное массовое действие — ошибка, а не «тронуто N» вхолостую', () => {
    const before = only(root).cases[0]?.updatedAt;

    expect(() =>
      bulkCases(root, { groupId: 'gui', caseIds: ['gui-001'], action: 'explode' as 'tag' }, NOW),
    ).toThrow(/explode/);
    expect(only(root).cases[0]?.updatedAt).toBe(before);
  });

  it('приоритет, готовность и автоматизация вне словаря не стирают поле', () => {
    expect(() =>
      bulkCases(
        root,
        { groupId: 'gui', caseIds: ['gui-001'], action: 'priority', value: 'urgent' },
        NOW,
      ),
    ).toThrow(/urgent/);
    expect(() =>
      bulkCases(
        root,
        { groupId: 'gui', caseIds: ['gui-001'], action: 'readiness', value: 'meh' },
        NOW,
      ),
    ).toThrow(/meh/);
    expect(() =>
      bulkCases(
        root,
        { groupId: 'gui', caseIds: ['gui-001'], action: 'automation', value: 'robot' },
        NOW,
      ),
    ).toThrow(/robot/);
    expect(only(root).cases[0]?.priority).toBe('high');

    bulkCases(
      root,
      { groupId: 'gui', caseIds: ['gui-001'], action: 'priority', value: 'low' },
      NOW,
    );
    expect(only(root).cases[0]?.priority).toBe('low');
  });

  it('массовое действие по несуществующей группе — 404', () => {
    expect(() =>
      bulkCases(root, { groupId: 'nope', caseIds: ['gui-001'], action: 'tag', value: 'x' }, NOW),
    ).toThrow(ProjectTestsNotFoundError);
  });

  it('вложения результата копятся в кейсе, а не заменяют прошлые', () => {
    applyResults(
      root,
      [{ groupId: 'gui', caseId: 'gui-001', status: 'failed', attachments: ['a.png'] }],
      NOW,
    );
    applyResults(
      root,
      [{ groupId: 'gui', caseId: 'gui-001', status: 'failed', attachments: ['b.png', 'a.png'] }],
      NOW,
    );

    expect(only(root).cases[0]?.attachments).toEqual(['a.png', 'b.png']);
  });
});
