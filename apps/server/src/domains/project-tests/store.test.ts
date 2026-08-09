import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ProjectTestsError,
  createGroup,
  readGroups,
  removeCase,
  removeGroup,
  resetStatuses,
  upsertCase,
} from './store.ts';

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

  it('чинит небрежность агента: шаги строкой, чужой статус, пустой id', () => {
    writeGroupFile(root, 'gui', {
      version: 1,
      cases: [{ title: 'Открыть чат', steps: 'зайти\nнажать', status: 'ok' }],
    });

    expect(only(root).cases[0]).toMatchObject({
      id: 'case-1',
      steps: ['зайти', 'нажать'],
      status: 'unknown',
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
    expect(cases[0]).toMatchObject({ title: 'Стало', steps: ['шаг'] });
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

  it('имя группы за пределами разрешённого отклоняется — это имя файла', () => {
    expect(() => createGroup(root, '../../etc')).toThrow(ProjectTestsError);
    expect(() => createGroup(root, 'ГУИ')).toThrow(ProjectTestsError);
  });
});
